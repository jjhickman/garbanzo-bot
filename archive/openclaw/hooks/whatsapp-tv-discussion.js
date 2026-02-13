#!/usr/bin/env node
/**
 * WhatsApp TV Episode Discussion Hook
 * Auto-detects popular show mentions and suggests discussion threads
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const ENTERTAINMENT_GROUP = '120363423376896818@g.us';

// Popular shows to watch for
const POPULAR_SHOWS = [
  'the bear', 'bear season',
  'succession',
  'last of us',
  'severance',
  'white lotus',
  'abbott elementary',
  'andor',
  'house of the dragon', 'hotd',
  'rings of power',
  'stranger things',
  'wednesday',
  'yellowstone',
  'true detective'
];

// Track recent discussions to avoid spam
const recentDiscussions = new Map();
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

async function handleMessage(context) {
  const { message, channel } = context;
  
  // Only process WhatsApp Entertainment group
  if (channel !== 'whatsapp' || message.from !== ENTERTAINMENT_GROUP) return;
  if (!message.body) return;
  
  const bodyLower = message.body.toLowerCase();
  
  // Check for show mentions
  const mentionedShow = POPULAR_SHOWS.find(show => bodyLower.includes(show));
  if (!mentionedShow) return;
  
  // Check cooldown
  const now = Date.now();
  const lastDiscussion = recentDiscussions.get(mentionedShow);
  if (lastDiscussion && (now - lastDiscussion) < COOLDOWN_MS) {
    console.log(`[TV Discussion] ${mentionedShow} discussed recently, skipping`);
    return;
  }
  
  // Check for episode mentions (e.g., "episode 3", "ep 3", "s2e3")
  const episodeMention = /(?:episode|ep|s\d+e)\s*\d+/i.test(bodyLower);
  
  // Check for watching signals
  const watchingSignals = ['watching', 'watched', 'just finished', 'started', 'binged', 'binging'];
  const isWatching = watchingSignals.some(signal => bodyLower.includes(signal));
  
  if (!episodeMention && !isWatching) return;
  
  console.log(`[TV Discussion] Detected ${mentionedShow} discussion, offering thread`);
  
  // Format show name nicely
  const showName = mentionedShow
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  
  const response = `📺 *Watching ${showName}?*

Looks like people are talking about this show! 

*Want a dedicated discussion thread?*
✅ React to this message if you'd like a spoiler-safe thread
💬 Or just keep chatting here (mark spoilers clearly!)

__________

*Spoiler Etiquette:*
⚠️ Use "SPOILER:" before revealing plot points
⚠️ Give people time to catch up
⚠️ When in doubt, spoiler tag it

Happy watching! 🍿`;
  
  try {
    // Send via wacli
    const cmd = `echo "${response.replace(/"/g, '\\"')}" | wacli send text --to "${ENTERTAINMENT_GROUP}" --message "$(cat -)"`;
    await execPromise(cmd, { shell: '/bin/bash' });
    
    // Update cooldown
    recentDiscussions.set(mentionedShow, now);
    
    console.log(`[TV Discussion] Sent discussion prompt for ${mentionedShow}`);
  } catch (error) {
    console.error('[TV Discussion] Error sending message:', error);
  }
}

// Export for OpenClaw hook system
module.exports = {
  name: 'whatsapp-tv-discussion',
  description: 'Auto-suggests discussion threads for popular TV shows',
  events: ['message'],
  handler: handleMessage
};

// CLI mode for testing
if (require.main === module) {
  const testMessage = {
    message: {
      from: ENTERTAINMENT_GROUP,
      body: 'Just finished watching The Bear episode 3, holy shit that was intense'
    },
    channel: 'whatsapp'
  };
  
  console.log('Testing TV discussion hook...');
  handleMessage(testMessage);
}
