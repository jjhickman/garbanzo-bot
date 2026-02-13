#!/usr/bin/env node
/**
 * WhatsApp Auto-Welcome Hook
 * Detects new member joins and sends welcome message
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const GROUP_IDS = {
  introductions: '120363405986870419@g.us',
  general: '120363423357339667@g.us'
};

async function handleMessage(context) {
  const { message, channel } = context;
  
  // Only process WhatsApp messages
  if (channel !== 'whatsapp') return;
  
  // Check if this is a group join notification
  if (!message.isGroupNotification) return;
  
  // Check if it's a member add notification
  const isNewMember = message.body?.includes('joined using this group\'s invite link') ||
                       message.body?.includes('added') ||
                       message.type === 'notification_template' &&
                       message.recipients?.length > 0;
  
  if (!isNewMember) return;
  
  // Extract member info
  let memberName = 'there';
  let memberPhone = null;
  
  // Try to extract phone number and name from notification
  if (message.recipients && message.recipients.length > 0) {
    memberPhone = message.recipients[0];
    // Get name from contact if available
    if (message.contacts && message.contacts.length > 0) {
      memberName = message.contacts[0].name || message.contacts[0].pushname || memberName;
    }
  }
  
  console.log(`[Auto-Welcome] New member detected: ${memberName} (${memberPhone || 'unknown'})`);
  
  // Only welcome in Introductions group
  if (message.from !== GROUP_IDS.introductions) {
    console.log(`[Auto-Welcome] Join detected in ${message.from}, but only welcoming in Introductions`);
    return;
  }
  
  // Call welcome script
  try {
    const scriptPath = `${process.env.HOME}/.openclaw/workspace/scripts/welcome-new-member.sh`;
    const cmd = `bash "${scriptPath}" "${memberName}" "${memberPhone || ''}"`;
    
    const { stdout, stderr } = await execPromise(cmd);
    
    if (stdout) console.log('[Auto-Welcome]', stdout);
    if (stderr) console.error('[Auto-Welcome Error]', stderr);
    
    // Also call icebreaker after a delay (5 seconds)
    setTimeout(async () => {
      const icebreakerCmd = `bash "${process.env.HOME}/.openclaw/workspace/scripts/icebreaker.sh" "${GROUP_IDS.introductions}" "${memberName}"`;
      await execPromise(icebreakerCmd);
      console.log(`[Auto-Welcome] Sent icebreaker for ${memberName}`);
    }, 5000);
    
  } catch (error) {
    console.error('[Auto-Welcome] Error running welcome script:', error);
  }
}

// Export for OpenClaw hook system
module.exports = {
  name: 'whatsapp-auto-welcome',
  description: 'Automatically welcome new members to WhatsApp groups',
  events: ['message'],
  handler: handleMessage
};

// CLI mode for testing
if (require.main === module) {
  const testMessage = {
    message: {
      from: GROUP_IDS.introductions,
      body: 'Alice joined using this group\'s invite link',
      isGroupNotification: true,
      recipients: ['+15555550123'],
      contacts: [{ name: 'Alice', pushname: 'Alice' }],
      type: 'notification_template'
    },
    channel: 'whatsapp'
  };
  
  console.log('Testing auto-welcome hook...');
  handleMessage(testMessage);
}
