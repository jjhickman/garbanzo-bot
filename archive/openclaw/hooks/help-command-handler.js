/**
 * Help Command Handler Hook
 * 
 * Detects when users ask for help and responds with usage information
 * 
 * Event: message.inbound
 * Action: Respond with help content when requested
 */

const { execSync } = require('child_process');

// Help trigger patterns
const HELP_PATTERNS = [
  // Direct help requests
  /\bhelp\b/i,
  /\bcommands?\b/i,
  /what can you do/i,
  /how do i use/i,
  /how does .* work/i,
  
  // Specific help topics
  /help (events?|fun|weather|transit|voice|general|examples?)/i,
  
  // Confused/lost signals
  /what are you/i,
  /who are you/i,
  /what'?s this bot/i,
];

// Bot mention patterns
const MENTION_PATTERNS = [
  /@garbanzo/i,
  /garbanzo/i,
  /@bean/i,
];

/**
 * Detect if message is asking for help
 */
function isHelpRequest(text) {
  for (const pattern of HELP_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract help topic from message
 */
function extractHelpTopic(text) {
  const topicMatch = text.match(/help\s+(events?|fun|weather|transit|voice|general|examples?)/i);
  if (topicMatch) {
    return topicMatch[1].toLowerCase();
  }
  
  // Check for specific topic keywords without "help"
  if (/event/i.test(text)) return 'events';
  if (/fun|game|challenge/i.test(text)) return 'fun';
  if (/weather/i.test(text)) return 'weather';
  if (/transit|mbta|train|subway/i.test(text)) return 'transit';
  if (/voice|speak|say/i.test(text)) return 'voice';
  if (/example/i.test(text)) return 'examples';
  
  return 'menu'; // Default to main menu
}

/**
 * Check if bot is mentioned
 */
function isMentioned(text) {
  for (const pattern of MENTION_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Get help content
 */
function getHelpContent(topic) {
  try {
    const scriptPath = '/home/josh/.openclaw/workspace/scripts/help-system.sh';
    const result = execSync(`${scriptPath} ${topic}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
      shell: '/bin/bash',
      cwd: '/home/josh/.openclaw/workspace'
    });
    
    return result.trim();
  } catch (error) {
    console.error('[Help Handler] Failed to get help content:', error.message);
    return `🫘 *Garbanzo Bean*\n\nI can help with events, weather, transit, fun activities, and more!\n\nTry: "@Garbanzo help events"`;
  }
}

/**
 * Send WhatsApp message
 */
function sendWhatsAppMessage(groupId, message) {
  try {
    const escaped = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const cmd = `wacli send text --to "${groupId}" --message "${escaped}"`;
    
    execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
      shell: '/bin/bash'
    });
    
    return true;
  } catch (error) {
    console.error('[Help Handler] Failed to send message:', error.message);
    return false;
  }
}

/**
 * Handle inbound message events
 */
async function handleInboundMessage(event, context) {
  const { message, channel, peer } = event;

  // Only process WhatsApp messages
  if (channel !== 'whatsapp') {
    return event;
  }

  // Only process text messages
  if (!message?.text) {
    return event;
  }

  const groupId = peer.id;
  const text = message.text;
  
  // Check if this is a help request
  const isHelp = isHelpRequest(text);
  const mentioned = isMentioned(text);
  
  // Respond to help requests (especially if mentioned, or direct help keywords)
  if (isHelp && (mentioned || peer.kind === 'dm')) {
    console.log('[Help Handler] 📖 Help request detected');
    
    const topic = extractHelpTopic(text);
    console.log('[Help Handler] Topic:', topic);
    
    // Get help content in background to not block
    setTimeout(() => {
      try {
        const helpContent = getHelpContent(topic);
        sendWhatsAppMessage(groupId, helpContent);
        console.log('[Help Handler] ✅ Help sent');
      } catch (error) {
        console.error('[Help Handler] Failed to send help:', error.message);
      }
    }, 100);
  }
  
  // Pass through the original event
  return event;
}

module.exports = {
  handleInboundMessage
};
