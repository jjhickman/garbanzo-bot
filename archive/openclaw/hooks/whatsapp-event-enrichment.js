/**
 * WhatsApp Event Enrichment Hook
 * 
 * Automatically enriches event-related messages with:
 * - Venue suggestions (event-planner)
 * - Weather forecast
 * - MBTA transit info
 * - Creates calendar events
 * - Logs to Obsidian vault
 * 
 * Event: message.inbound
 * Action: Detect event creation, enrich with contextual info
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Event detection patterns
const EVENT_PATTERNS = [
  // Direct event creation
  /(?:let'?s|should we|want to|planning|organizing)\s+(?:do|have|plan|go(?:\s+to)?|attend)\s+(.+?)(?:\s+(?:on|this|next|tomorrow|friday|saturday|sunday|monday|tuesday|wednesday|thursday))/i,
  
  // "Event on date"
  /(.+?)\s+(?:on|this|next)\s+(friday|saturday|sunday|monday|tuesday|wednesday|thursday|tonight|tomorrow|weekend)/i,
  
  // "Anyone interested in..."
  /anyone\s+(?:interested|down|want|wanna)\s+(?:in|for|to)\s+(.+?)\??$/i,
  
  // "Who wants to..."
  /who\s+(?:wants?|is)\s+(?:to|down|in)\s+(?:for|go(?:\s+to)?)\s+(.+?)\??$/i,
  
  // Direct activity mentions with time
  /(trivia|karaoke|bar\s+crawl|drinks|dinner|brunch|lunch|coffee|game\s+night|movie|concert|show)\s+(?:at|@|tonight|tomorrow|this|next)/i
];

// Event update patterns
const UPDATE_PATTERNS = [
  // "Change X to Y"
  /change\s+(?:the\s+)?(\w+)\s+(?:event|time|date|venue)?\s*(?:to|for)\s+(.+)/i,
  
  // "Update X event"
  /update\s+(?:the\s+)?(\w+)\s+event/i,
  
  // "Move X to Y"
  /move\s+(\w+)\s+(?:to|for)\s+(.+)/i,
  
  // "What's the weather for X"
  /what'?s?\s+the\s+weather\s+(?:for|on)\s+(.+)/i,
  
  // "Cancel X"
  /cancel\s+(?:the\s+)?(\w+)/i
];

// Time extraction patterns
const TIME_PATTERNS = [
  /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
  /at\s+(\d{1,2})(?::(\d{2}))?/i,
  /(afternoon|morning|evening|night)/i
];

// Date extraction patterns
const DATE_PATTERNS = [
  /(tonight|tomorrow|today)/i,
  /(this|next)\s+(friday|saturday|sunday|monday|tuesday|wednesday|thursday|weekend)/i,
  /(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\s+(night|afternoon|evening|morning)/i,
  /(\d{1,2})\/(\d{1,2})/,  // MM/DD
  /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/i
];

// Activity type mapping
const ACTIVITY_TYPES = {
  'trivia': 'trivia night',
  'karaoke': 'karaoke night',
  'bar crawl': 'bar crawl',
  'drinks': 'drinks',
  'dinner': 'dinner',
  'brunch': 'brunch',
  'lunch': 'lunch',
  'coffee': 'coffee meetup',
  'game night': 'game night',
  'movie': 'movie',
  'concert': 'concert',
  'show': 'show'
};

/**
 * Detect if message is proposing an event
 */
function detectEventProposal(text) {
  for (const pattern of EVENT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        detected: true,
        activity: match[1] ? match[1].trim() : match[0],
        rawText: text
      };
    }
  }
  return { detected: false };
}

/**
 * Detect if message is requesting an event update
 */
function detectEventUpdate(text) {
  for (const pattern of UPDATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        detected: true,
        type: determineUpdateType(text),
        activity: match[1] ? match[1].trim() : null,
        newValue: match[2] ? match[2].trim() : null,
        rawText: text
      };
    }
  }
  return { detected: false };
}

/**
 * Determine what type of update is being requested
 */
function determineUpdateType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('cancel')) return 'cancel';
  if (lower.includes('weather')) return 'weather-check';
  if (lower.includes('time')) return 'time-update';
  if (lower.includes('date')) return 'date-update';
  if (lower.includes('venue') || lower.includes('location')) return 'venue-update';
  if (lower.includes('move')) return 'reschedule';
  return 'general-update';
}

/**
 * Find event file in Obsidian vault
 */
function findEventFile(activity, dateHint) {
  try {
    const eventsDir = path.join(process.env.HOME, 'Documents', 'BostonCommunity', 'Events');
    
    if (!fs.existsSync(eventsDir)) {
      return null;
    }
    
    // Normalize activity for matching
    const activityNorm = activity.toLowerCase().replace(/\s+/g, '-');
    
    // Find files matching activity
    const files = fs.readdirSync(eventsDir)
      .filter(f => f.endsWith('.md'))
      .filter(f => f.toLowerCase().includes(activityNorm));
    
    if (files.length === 0) return null;
    
    // If we have a date hint, prefer files with that date
    if (dateHint) {
      const dateNorm = dateHint.toLowerCase();
      const dateFile = files.find(f => f.toLowerCase().includes(dateNorm));
      if (dateFile) {
        return path.join(eventsDir, dateFile);
      }
    }
    
    // Return most recent file
    const sorted = files.sort().reverse();
    return path.join(eventsDir, sorted[0]);
  } catch (error) {
    console.error('[Event Update] Failed to find event file:', error.message);
    return null;
  }
}

/**
 * Run event update script
 */
function runEventUpdate(eventFile, updateData, groupId) {
  try {
    const scriptPath = '/home/josh/.openclaw/workspace/scripts/update-event.sh';
    
    let cmd = `${scriptPath} --file "${eventFile}"`;
    
    if (updateData.newTime) cmd += ` --time "${updateData.newTime}"`;
    if (updateData.newDate) cmd += ` --date "${updateData.newDate}"`;
    if (updateData.newVenue) cmd += ` --venue "${updateData.newVenue}"`;
    if (updateData.reason) cmd += ` --reason "${updateData.reason}"`;
    if (groupId) cmd += ` --group "${groupId}" --send`;
    
    console.log('[Event Update] Running:', cmd);
    
    const result = execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
      shell: '/bin/bash',
      cwd: '/home/josh/.openclaw/workspace'
    });
    
    return result;
  } catch (error) {
    console.error('[Event Update] Update script failed:', error.message);
    return null;
  }
}

/**
 * Extract time from message
 */
function extractTime(text) {
  for (const pattern of TIME_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      if (match[1] && match[3]) {
        // "7pm" or "7:30pm"
        let hour = parseInt(match[1]);
        const minute = match[2] ? parseInt(match[2]) : 0;
        const ampm = match[3].toLowerCase();
        
        if (ampm === 'pm' && hour !== 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        
        return { hour, minute, formatted: `${match[1]}${match[2] ? ':' + match[2] : ''}${match[3]}` };
      }
      if (match[1] && !match[3]) {
        // "at 7"
        const hour = parseInt(match[1]);
        return { hour, minute: 0, formatted: `${hour}:00` };
      }
      if (match[1] === 'afternoon') return { hour: 14, minute: 0, formatted: 'afternoon (2pm)' };
      if (match[1] === 'morning') return { hour: 10, minute: 0, formatted: 'morning (10am)' };
      if (match[1] === 'evening') return { hour: 18, minute: 0, formatted: 'evening (6pm)' };
      if (match[1] === 'night') return { hour: 19, minute: 0, formatted: 'night (7pm)' };
    }
  }
  return null;
}

/**
 * Extract date from message
 */
function extractDate(text) {
  const now = new Date();
  
  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      if (match[1] === 'tonight' || match[1] === 'today') {
        return { date: now, formatted: 'tonight', relative: 'today' };
      }
      if (match[1] === 'tomorrow') {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return { date: tomorrow, formatted: 'tomorrow', relative: 'tomorrow' };
      }
      if (match[2]) {
        // "this Friday", "next Saturday"
        const dayOfWeek = match[2].toLowerCase();
        const isNext = match[1].toLowerCase() === 'next';
        const targetDate = getNextDayOfWeek(dayOfWeek, isNext);
        return { date: targetDate, formatted: `${match[1]} ${match[2]}`, relative: `${match[1]}_${dayOfWeek}` };
      }
    }
  }
  return null;
}

/**
 * Get next occurrence of a day of week
 */
function getNextDayOfWeek(dayName, skipThisWeek = false) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetDay = days.indexOf(dayName.toLowerCase());
  
  if (targetDay === -1) return null;
  
  const today = new Date();
  const currentDay = today.getDay();
  
  let daysUntilTarget = targetDay - currentDay;
  if (daysUntilTarget < 0) daysUntilTarget += 7;
  if (skipThisWeek || daysUntilTarget === 0) daysUntilTarget += 7;
  
  const result = new Date(today);
  result.setDate(today.getDate() + daysUntilTarget);
  return result;
}

/**
 * Normalize activity type
 */
function normalizeActivity(activity) {
  const lower = activity.toLowerCase();
  for (const [key, normalized] of Object.entries(ACTIVITY_TYPES)) {
    if (lower.includes(key)) {
      return normalized;
    }
  }
  return activity;
}

/**
 * Run event planning workflow
 */
function runEventWorkflow(eventData) {
  try {
    const scriptPath = '/home/josh/.openclaw/workspace/scripts/event-planning-workflow.sh';
    const activity = normalizeActivity(eventData.activity);
    const date = eventData.date ? eventData.date.toISOString().split('T')[0] : '';
    
    const cmd = `${scriptPath} --type "${activity}" --party-size 6 ${date ? `--date "${date}"` : ''}`;
    
    const result = execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
      shell: '/bin/bash',
      cwd: '/home/josh/.openclaw/workspace'
    });
    
    return result;
  } catch (error) {
    console.error('[Event Enrichment] Workflow failed:', error.message);
    return null;
  }
}

/**
 * Create calendar event
 */
function createCalendarEvent(eventData) {
  try {
    // TODO: Implement gcalcli integration after it's configured
    // For now, just log the event structure
    console.log('[Event Enrichment] Calendar event (gcalcli not configured yet):', {
      title: eventData.activity,
      date: eventData.date,
      time: eventData.time,
      location: 'Boston, MA'
    });
    return true;
  } catch (error) {
    console.error('[Event Enrichment] Calendar creation failed:', error.message);
    return false;
  }
}

/**
 * Log event to Obsidian vault
 */
function logEventToVault(eventData, groupName) {
  try {
    const vaultPath = path.join(process.env.HOME, 'Documents', 'BostonCommunity');
    const eventsDir = path.join(vaultPath, 'Events');
    
    if (!fs.existsSync(eventsDir)) {
      fs.mkdirSync(eventsDir, { recursive: true });
    }
    
    const dateStr = eventData.date ? eventData.date.toISOString().split('T')[0] : 'TBD';
    const filename = `${dateStr}-${eventData.activity.replace(/\s+/g, '-')}.md`;
    const filepath = path.join(eventsDir, filename);
    
    const content = `# ${eventData.activity}

**Date:** ${eventData.dateFormatted || 'TBD'}
**Time:** ${eventData.timeFormatted || 'TBD'}
**Group:** ${groupName}
**Proposed by:** ${eventData.proposedBy || 'Unknown'}

## Details

${eventData.enrichmentData || '_Enrichment pending..._'}

## Attendees

- [ ] TBD

## Notes

_Add notes here..._
`;
    
    fs.writeFileSync(filepath, content);
    console.log('[Event Enrichment] ✅ Logged to Obsidian:', filepath);
    return filepath;
  } catch (error) {
    console.error('[Event Enrichment] Failed to log to vault:', error.message);
    return null;
  }
}

/**
 * Generate enriched event response
 */
function generateEventResponse(eventData, workflowResult) {
  const activity = eventData.activity;
  const dateStr = eventData.dateFormatted || 'a date TBD';
  const timeStr = eventData.timeFormatted || 'a time TBD';
  
  let response = `🎉 *Event Detected!*\n\n`;
  response += `*Activity:* ${activity}\n`;
  response += `*When:* ${dateStr}${timeStr !== 'a time TBD' ? ` at ${timeStr}` : ''}\n\n`;
  
  if (workflowResult) {
    // Extract key info from workflow result
    const venueMatch = workflowResult.match(/### 1\.\s+(.+?)[\n\r]/);
    const weatherMatch = workflowResult.match(/Temperature:\s*(.+?)[\n\r]/);
    
    if (venueMatch) {
      response += `📍 *Suggested Venue:* ${venueMatch[1]}\n`;
    }
    if (weatherMatch) {
      response += `🌤️ *Weather:* ${weatherMatch[1]}\n`;
    }
    response += `🚇 *Transit:* Red Line to Park Street or Downtown Crossing\n\n`;
  }
  
  response += `React with 👍 if you're interested!\n`;
  response += `\n_I'll track RSVPs and send reminders closer to the date._`;
  
  return response;
}

/**
 * Send WhatsApp message (with optional reply)
 */
function sendWhatsAppMessage(groupId, message, options = {}) {
  try {
    // Using wacli for now
    const escaped = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    
    // Note: wacli doesn't support --reply-to yet
    // This is a placeholder for when it does
    // For now, we prepend a reference to make the connection clear
    let finalMessage = message;
    if (options.replyTo) {
      // Add a reference indicator until reply-to is supported
      finalMessage = `↩️ *Event Details*\n\n${message}`;
    }
    
    const finalEscaped = finalMessage.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const cmd = `wacli send text --to "${groupId}" --message "${finalEscaped}"`;
    
    execSync(cmd, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
      shell: '/bin/bash'
    });
    
    return true;
  } catch (error) {
    console.error('[Event Enrichment] Failed to send message:', error.message);
    return false;
  }
}

/**
 * Detect if message is a WhatsApp native event
 */
function isWhatsAppNativeEvent(message) {
  if (message.type === "event" || message.type === "eventMessage") return true;
  if (message.event || message.eventMessage || message.eventData) return true;
  if (message.eventTitle || message.eventDate || message.eventTime) return true;
  return false;
}

/**
 * Extract WhatsApp native event details
 */
function extractNativeEventDetails(message) {
  const eventData = message.event || message.eventMessage || message.eventData || {};
  return {
    title: eventData.title || message.eventTitle || "Event",
    description: eventData.description || eventData.desc || "",
    date: eventData.date || message.eventDate || null,
    time: eventData.time || message.eventTime || null,
    location: eventData.location || eventData.place || "Boston, MA",
    attendees: eventData.attendees || [],
    isNativeEvent: true
  };
}

/**
 * Handle inbound message events
 */
async function handleInboundMessage(event, context) {
  const { message, channel, peer } = event;

  // Only process WhatsApp group messages
  if (channel !== 'whatsapp' || peer?.kind !== 'group') {
    return event;
  }

  // Only process text messages
  if (!message?.text) {
    return event;
  }

  const groupName = peer.name || peer.id;
  const groupId = peer.id;
  const senderName = message.author?.name || 'Unknown';
  
  // Debug: Log message structure (set DEBUG_EVENTS=1 to enable)
  if (process.env.DEBUG_EVENTS) {
    console.log("[Event Enrichment] 🔍 Message:", JSON.stringify({
      type: message.type,
      hasText: !!message.text,
      hasEvent: !!(message.event || message.eventMessage),
      keys: Object.keys(message)
    }, null, 2));
  }
  
  // Check for WhatsApp native events FIRST
  if (isWhatsAppNativeEvent(message)) {
    console.log("[Event Enrichment] 📱 WhatsApp native event detected!");
    
    const nativeEvent = extractNativeEventDetails(message);
    console.log("[Event Enrichment] Event details:", nativeEvent);
    
    // Capture message ID for reply reference
    const eventMessageId = message.id;
    
    // Enrich in background
    setTimeout(() => {
      try {
        const eventData = {
          activity: nativeEvent.title,
          rawText: nativeEvent.description,
          time: nativeEvent.time ? { formatted: nativeEvent.time } : null,
          timeFormatted: nativeEvent.time,
          date: nativeEvent.date ? new Date(nativeEvent.date) : null,
          dateFormatted: nativeEvent.date,
          proposedBy: senderName,
          groupName,
          groupId,
          location: nativeEvent.location,
          isNativeEvent: true
        };
        
        const workflowResult = runEventWorkflow(eventData);
        createCalendarEvent(eventData);
        eventData.enrichmentData = workflowResult;
        logEventToVault(eventData, groupName);
        
        let response = generateEventResponse(eventData, workflowResult);
        response = "📱 *WhatsApp Event Detected!*\n\n" + response;
        
        // Reply to the event message to link enrichment
        sendWhatsAppMessage(groupId, response, { replyTo: eventMessageId });
        
        console.log("[Event Enrichment] ✅ Native event enriched");
      } catch (error) {
        console.error("[Event Enrichment] Native event enrichment failed:", error.message);
      }
    }, 100);
    
    return event;
  }
  
  // Check for event updates first
  const eventUpdate = detectEventUpdate(message.text);
  
  if (eventUpdate.detected) {
    console.log('[Event Update] 📝 Update request detected:', eventUpdate.type);
    
    // Find the event file
    const eventFile = findEventFile(eventUpdate.activity, null);
    
    if (!eventFile) {
      console.log('[Event Update] Event not found for:', eventUpdate.activity);
      // Could respond with "Which event did you mean?" but for now, pass through
      return event;
    }
    
    // Parse the update request
    const updateData = {
      reason: `Requested by ${senderName}`
    };
    
    switch (eventUpdate.type) {
      case 'time-update':
        const timeMatch = eventUpdate.newValue?.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
          updateData.newTime = eventUpdate.newValue;
        }
        break;
      
      case 'date-update':
      case 'reschedule':
        updateData.newDate = eventUpdate.newValue;
        break;
      
      case 'venue-update':
        updateData.newVenue = eventUpdate.newValue;
        break;
      
      case 'weather-check':
        // Just refresh weather, no changes
        updateData.reason = 'Weather forecast update';
        break;
      
      case 'cancel':
        updateData.reason = `Cancelled by ${senderName}`;
        updateData.newDate = 'CANCELLED';
        break;
    }
    
    // Run update in background
    setTimeout(() => {
      try {
        runEventUpdate(eventFile, updateData, groupId);
        console.log('[Event Update] ✅ Event updated');
      } catch (error) {
        console.error('[Event Update] Background update failed:', error.message);
      }
    }, 100);
    
    return event; // Pass through original message
  }
  
  // Detect event proposals
  const eventProposal = detectEventProposal(message.text);
  
  if (!eventProposal.detected) {
    return event; // Not an event, pass through
  }

  console.log('[Event Enrichment] 🎉 Event detected in', groupName);
  console.log('[Event Enrichment] Activity:', eventProposal.activity);
  
  // Extract time and date
  const time = extractTime(message.text);
  const date = extractDate(message.text);
  
  const eventData = {
    activity: eventProposal.activity,
    rawText: eventProposal.rawText,
    time,
    timeFormatted: time?.formatted,
    date: date?.date,
    dateFormatted: date?.formatted,
    proposedBy: senderName,
    groupName,
    groupId
  };
  
  console.log('[Event Enrichment] Parsed event:', {
    activity: eventData.activity,
    date: eventData.dateFormatted,
    time: eventData.timeFormatted
  });
  
  // Run enrichment workflow in background (don't block)
  setTimeout(() => {
    try {
      // Run event planning workflow
      const workflowResult = runEventWorkflow(eventData);
      
      // Create calendar event
      createCalendarEvent(eventData);
      
      // Log to Obsidian
      const vaultPath = logEventToVault(eventData, groupName);
      
      // Generate and send enriched response
      const response = generateEventResponse(eventData, workflowResult);
      
      // Send back to group
      sendWhatsAppMessage(groupId, response);
      
      console.log('[Event Enrichment] ✅ Event enriched and posted:', eventData.activity);
    } catch (error) {
      console.error('[Event Enrichment] Background enrichment failed:', error.message);
    }
  }, 100); // Small delay to not block message handling
  
  // Return the original event unmodified
  return event;
}

module.exports = {
  handleInboundMessage
};
