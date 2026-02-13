/**
 * WhatsApp Content Moderation Hook
 * 
 * Intercepts incoming WhatsApp messages and moderates them via Vettly.
 * Implements progressive enforcement: warn → notify admins → ban recommendations
 * 
 * Event: message.inbound
 * Action: Logs, warns, notifies, tracks violations
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const VIOLATION_DB_PATH = '/home/josh/.openclaw/data/moderation-violations.json';
const ADMINS = [
  'Josh Hickman',    // Owner
  'George Sotelo',   // Admin
  'Rana M'          // Admin
];

// WhatsApp Group IDs (name → JID mapping)
const GROUP_IDS = {
  'Entertainment': '120363423376896818@g.us',
  'Events': '120363423189270382@g.us',
  'Hobbies': '120363421084703266@g.us',
  'Book Club': '120363423476654822@g.us',
  'Shitposting': '120363407643871544@g.us',
  'Introductions': '120363405986870419@g.us',
  'General': '120363423357339667@g.us',
  'Guild of Musicians': '120363427236939160@g.us'
};

// Thresholds for detection (scores >= threshold trigger action)
const THRESHOLDS = {
  violence: 0.7,
  hate_speech: 0.7,
  harassment: 0.7,
  spam: 0.8,
  sexual: 0.7,
  self_harm: 0.7
};

// Severity levels based on category and score
const SEVERITY_LEVELS = {
  CRITICAL: { minScore: 0.9, categories: ['violence', 'hate_speech', 'self_harm'] },
  HIGH: { minScore: 0.8, categories: ['harassment', 'sexual'] },
  MEDIUM: { minScore: 0.7, categories: ['spam'] },
  LOW: { minScore: 0.6, categories: ['spam'] }
};

// Admin contact info (phone numbers for DMs)
// TODO: Add actual admin phone numbers after Wednesday
const ADMIN_CONTACTS = {
  'Josh Hickman': '+1234567890',  // Replace with actual
  'George Sotelo': '+1234567890',  // Replace with actual
  'Rana M': '+1234567890'          // Replace with actual
};

// Progressive enforcement rules
const ENFORCEMENT_LEVELS = {
  1: { action: 'warn_user', label: '1st offense: Warning' },
  2: { action: 'notify_admins', label: '2nd offense: Admin notification' },
  3: { action: 'recommend_ban', label: '3rd offense: Ban recommendation' }
};

/**
 * Load violation history from disk
 */
function loadViolations() {
  try {
    if (!fs.existsSync(VIOLATION_DB_PATH)) {
      return {};
    }
    const data = fs.readFileSync(VIOLATION_DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[WhatsApp Moderation] Failed to load violations:', error.message);
    return {};
  }
}

/**
 * Save violation history to disk
 */
function saveViolations(violations) {
  try {
    const dir = path.dirname(VIOLATION_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(VIOLATION_DB_PATH, JSON.stringify(violations, null, 2));
  } catch (error) {
    console.error('[WhatsApp Moderation] Failed to save violations:', error.message);
  }
}

/**
 * Record a violation for a user
 */
function recordViolation(userId, userName, groupName, category, score, messageText) {
  const violations = loadViolations();
  
  if (!violations[userId]) {
    violations[userId] = {
      userName,
      violations: [],
      totalCount: 0
    };
  }
  
  violations[userId].violations.push({
    timestamp: new Date().toISOString(),
    groupName,
    category,
    score,
    messagePreview: messageText.substring(0, 100)
  });
  
  violations[userId].totalCount = violations[userId].violations.length;
  violations[userId].userName = userName; // Update in case name changed
  
  saveViolations(violations);
  
  return violations[userId].totalCount;
}

/**
 * Get violation count for a user
 */
function getViolationCount(userId) {
  const violations = loadViolations();
  return violations[userId]?.totalCount || 0;
}

/**
 * Classify severity of a violation
 */
function classifySeverity(category, score) {
  if (SEVERITY_LEVELS.CRITICAL.categories.includes(category) && score >= SEVERITY_LEVELS.CRITICAL.minScore) {
    return 'CRITICAL';
  }
  if (SEVERITY_LEVELS.HIGH.categories.includes(category) && score >= SEVERITY_LEVELS.HIGH.minScore) {
    return 'HIGH';
  }
  if (score >= SEVERITY_LEVELS.MEDIUM.minScore) {
    return 'MEDIUM';
  }
  return 'LOW';
}

/**
 * Get recommended action based on severity and violation count
 */
function getRecommendedAction(severity, violationCount) {
  // Critical violations always escalate immediately
  if (severity === 'CRITICAL') {
    if (violationCount >= 2) return 'ban';
    if (violationCount >= 1) return 'notify_admins';
    return 'warn_and_notify';
  }
  
  // High severity escalates faster
  if (severity === 'HIGH') {
    if (violationCount >= 3) return 'ban';
    if (violationCount >= 2) return 'notify_admins';
    return 'warn_user';
  }
  
  // Medium/Low follow standard progression
  if (violationCount >= 3) return 'recommend_ban';
  if (violationCount >= 2) return 'notify_admins';
  return 'warn_user';
}

/**
 * Moderate content via Vettly MCP server
 */
function moderateContent(content, policyId = 'whatsapp-community') {
  try {
    const escaped = content
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, ' ')
      .replace(/\r/g, '');
    
    const cmd = `mcporter call vettly.moderate_content content="${escaped}" policyId=${policyId} contentType=text --output json`;
    
    const result = execSync(cmd, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      shell: '/bin/bash',
      cwd: '/home/josh/.openclaw/workspace'
    });
    
    const parsed = JSON.parse(result.trim());
    
    // Convert categories array to object
    if (Array.isArray(parsed.categories)) {
      const categoriesObj = {};
      parsed.categories.forEach(cat => {
        categoriesObj[cat.category] = cat.score;
      });
      parsed.categories = categoriesObj;
    }
    
    return parsed;
  } catch (error) {
    console.error('[WhatsApp Moderation] Failed to call Vettly:', error.message);
    return null;
  }
}

/**
 * Send a WhatsApp message (DM or group)
 */
function sendWhatsAppMessage(to, message, isGroup = false) {
  try {
    // Note: This assumes the WhatsApp plugin supports programmatic sending
    // You may need to adjust this based on your WhatsApp setup
    
    // Using the message tool via OpenClaw
    const escaped = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const cmd = `openclaw message send --channel whatsapp --to "${to}" --message "${escaped}"`;
    
    execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
      shell: '/bin/bash'
    });
    
    return true;
  } catch (error) {
    console.error('[WhatsApp Moderation] Failed to send message:', error.message);
    return false;
  }
}

/**
 * Warn a user via DM
 */
function warnUser(userId, userName, category, score, messageText, groupName) {
  const violationCount = getViolationCount(userId);
  
  const warning = `⚠️ *Content Moderation Warning* ⚠️

Hello ${userName},

Your recent message in *${groupName}* was flagged by our automated moderation system:

*Category:* ${category}
*Confidence:* ${(score * 100).toFixed(0)}%
*Message:* "${messageText.substring(0, 80)}${messageText.length > 80 ? '...' : ''}"

This is warning #${violationCount}. Please review our community guidelines and ensure future messages comply with our standards.

Continued violations may result in removal from the community.

— Garbanzo Bean 🫘
Community Moderation Team`;

  console.log(`[WhatsApp Moderation] 📨 Sending warning to ${userName}`);
  return sendWhatsAppMessage(userId, warning, false);
}

/**
 * Notify admins about a violation
 */
function notifyAdmins(userId, userName, category, score, messageText, groupName, violationCount, severity = 'MEDIUM') {
  const severityEmoji = severity === 'CRITICAL' ? '🚨🚨🚨' : severity === 'HIGH' ? '⚠️⚠️' : '⚠️';
  const urgency = severity === 'CRITICAL' ? 'URGENT - ' : severity === 'HIGH' ? 'High Priority - ' : '';
  
  const notification = `${severityEmoji} *Moderation Alert* ${severityEmoji}

${urgency}*${severity} SEVERITY VIOLATION*

*User:* ${userName}
*Group:* ${groupName}
*Violation #:* ${violationCount}
*Severity:* ${severity}

*Category:* ${category} (${(score * 100).toFixed(0)}% confidence)
*Message:* "${messageText.substring(0, 150)}${messageText.length > 150 ? '...' : ''}"

${violationCount >= 3 ? '⚠️ *User has exceeded threshold - ban recommended*' : `This user has ${violationCount} recorded violation${violationCount > 1 ? 's' : ''}. Please review and consider appropriate action.`}

— Automated Moderation System 🤖`;

  console.log(`[WhatsApp Moderation] 🔔 Notifying admins about ${userName} (${severity})`);
  console.log(`[WhatsApp Moderation] Admin notification:\n${notification}`);
  
  // Send to all admins via DM
  let sentCount = 0;
  Object.entries(ADMIN_CONTACTS).forEach(([adminName, phoneNumber]) => {
    // Only send if phone number is configured (not placeholder)
    if (phoneNumber && !phoneNumber.includes('1234567890')) {
      const sent = sendWhatsAppMessage(phoneNumber, notification, false);
      if (sent) sentCount++;
    } else {
      console.log(`[WhatsApp Moderation] Skipping ${adminName} (phone not configured)`);
    }
  });
  
  if (sentCount > 0) {
    console.log(`[WhatsApp Moderation] ✅ Sent to ${sentCount} admin(s)`);
  } else {
    console.warn(`[WhatsApp Moderation] ⚠️ No admin contacts configured yet`);
  }
  
  return true;
}

/**
 * Log a ban recommendation
 */
function recommendBan(userId, userName, category, score, messageText, groupName, violationCount) {
  const recommendation = `🚫 *BAN RECOMMENDATION* 🚫

*User:* ${userName} (${userId})
*Group:* ${groupName}
*Total violations:* ${violationCount}

*Latest offense:*
*Category:* ${category} (${(score * 100).toFixed(0)}%)
*Message:* "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"

This user has exceeded the violation threshold (${violationCount} offenses).
Manual review and potential ban recommended.

— Automated Moderation System 🤖`;

  console.error(`[WhatsApp Moderation] 🚫 BAN RECOMMENDED: ${userName}`);
  console.error(recommendation);
  
  // TODO: Send to admins or log to a review queue
  return true;
}

/**
 * Delete a message (if supported by WhatsApp plugin)
 */
function deleteMessage(messageId, groupId) {
  // Note: WhatsApp Web API may not support message deletion
  // This is a placeholder - implement if your setup supports it
  console.log(`[WhatsApp Moderation] 🗑️  Would delete message ${messageId} in ${groupId} (not implemented)`);
  return false;
}

/**
 * Enforce moderation action based on severity and violation count
 */
function enforceAction(userId, userName, category, score, messageText, groupName) {
  const violationCount = recordViolation(userId, userName, groupName, category, score, messageText);
  const severity = classifySeverity(category, score);
  const action = getRecommendedAction(severity, violationCount);
  
  const emoji = severity === 'CRITICAL' ? '🚨' : severity === 'HIGH' ? '⚠️' : '👀';
  console.log(`[WhatsApp Moderation] ${emoji} ${severity} violation #${violationCount} for ${userName} → ${action}`);
  
  switch (action) {
    case 'warn_user':
      warnUser(userId, userName, category, score, messageText, groupName);
      break;
      
    case 'warn_and_notify':
      // For critical first-time offenses
      warnUser(userId, userName, category, score, messageText, groupName);
      notifyAdmins(userId, userName, category, score, messageText, groupName, violationCount, severity);
      break;
      
    case 'notify_admins':
      warnUser(userId, userName, category, score, messageText, groupName);
      notifyAdmins(userId, userName, category, score, messageText, groupName, violationCount, severity);
      break;
      
    case 'recommend_ban':
      warnUser(userId, userName, category, score, messageText, groupName);
      notifyAdmins(userId, userName, category, score, messageText, groupName, violationCount, severity);
      recommendBan(userId, userName, category, score, messageText, groupName, violationCount);
      break;
      
    case 'ban':
      // Immediate ban recommendation for repeat critical offenders
      warnUser(userId, userName, category, score, messageText, groupName);
      notifyAdmins(userId, userName, category, score, messageText, groupName, violationCount, severity);
      recommendBan(userId, userName, category, score, messageText, groupName, violationCount);
      console.error(`[WhatsApp Moderation] 🚫 IMMEDIATE BAN RECOMMENDED for ${userName} (${severity} violation #${violationCount})`);
      break;
  }
  
  return { violationCount, severity, action };
}

/**
 * Handle inbound message events
 */
async function handleInboundMessage(event, context) {
  const { message, channel, peer } = event;

  // Only process WhatsApp messages
  if (channel !== 'whatsapp') {
    return;
  }

  // Only process text messages from groups
  if (!message?.text || peer?.kind !== 'group') {
    return;
  }

  const groupName = peer.name || peer.id;
  const senderId = message.author?.id || 'unknown';
  const senderName = message.author?.name || senderId;
  
  // Moderate the content
  const result = moderateContent(message.text);

  if (!result) {
    console.error('[WhatsApp Moderation] Moderation failed, allowing message by default');
    return;
  }

  const { safe, flagged, action, categories } = result;
  
  // Check for violations based on our thresholds
  const violations = Object.entries(categories || {})
    .filter(([cat, score]) => score >= (THRESHOLDS[cat] || 0.7))
    .map(([category, score]) => ({ category, score }));
  
  if (violations.length > 0) {
    const primary = violations[0]; // Take the highest scored violation
    const emoji = action === 'block' ? '🚫' : action === 'warn' ? '⚠️' : '👀';
    
    console.warn(`[WhatsApp Moderation] ${emoji} VIOLATION in ${groupName}: ${primary.category}(${primary.score.toFixed(2)})`);
    console.warn(`[WhatsApp Moderation] Sender: ${senderName} (${senderId})`);
    console.warn(`[WhatsApp Moderation] Message: "${message.text.substring(0, 100)}${message.text.length > 100 ? '...' : ''}"`);
    
    // Enforce progressive action
    enforceAction(senderId, senderName, primary.category, primary.score, message.text, groupName);
  }

  // Return the event unmodified (allow it to proceed)
  return event;
}

module.exports = {
  handleInboundMessage
};
