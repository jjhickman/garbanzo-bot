/**
 * Conversation summaries — on-demand "what did I miss?" for group catch-up.
 *
 * Commands:
 *   !summary          — summarize last 50 messages in this group
 *   !summary 100      — summarize last N messages (max 200)
 *   !catchup          — alias for !summary
 *   !missed           — alias for !summary
 *
 * Uses Claude to generate a concise summary of recent group conversation.
 * Only works in groups (not DMs).
 */

import { logger } from '../middleware/logger.js';
import { getMessages, type DbMessage } from '../utils/db.js';
import { getAIResponse } from '../ai/router.js';
import { getGroupName } from '../bot/groups.js';

const DEFAULT_MESSAGE_COUNT = 50;
const MAX_MESSAGE_COUNT = 200;

/**
 * Handle !summary command. Returns a summary string or error message.
 */
export async function handleSummary(
  args: string,
  groupJid: string,
  senderJid: string,
): Promise<string> {
  // Parse optional message count
  const countArg = args.trim().match(/^\d+/);
  let count = DEFAULT_MESSAGE_COUNT;
  if (countArg) {
    count = Math.min(parseInt(countArg[0], 10), MAX_MESSAGE_COUNT);
    if (count < 5) count = 5;
  }

  const messages = getMessages(groupJid, count);
  if (messages.length < 3) {
    return '📝 Not enough messages to summarize yet.';
  }

  const groupName = getGroupName(groupJid);
  const formatted = formatMessagesForSummary(messages);

  logger.info({ groupJid, groupName, messageCount: messages.length, requested: count }, 'Generating conversation summary');

  const prompt = [
    `Summarize the following ${messages.length} messages from the "${groupName}" WhatsApp group chat.`,
    'Give a concise bullet-point summary of:',
    '- Main topics discussed',
    '- Any decisions made or plans formed',
    '- Key questions asked (and answers if given)',
    '- Notable events or announcements',
    '',
    'Keep it under 500 chars. Use WhatsApp formatting (*bold* for topics). Skip greetings and small talk.',
    '',
    formatted,
  ].join('\n');

  const response = await getAIResponse(prompt, {
    groupName,
    groupJid,
    senderJid,
  });

  if (!response || response.includes('I hit a snag')) {
    return '📝 Could not generate summary right now. Try again in a moment.';
  }

  const timespan = getTimespan(messages);

  return [
    `📝 *Summary — ${groupName}* (${messages.length} messages, ${timespan})`,
    '',
    response,
  ].join('\n');
}

function formatMessagesForSummary(messages: DbMessage[]): string {
  return messages
    .map((m) => `[${m.sender}]: ${m.text}`)
    .join('\n');
}

function getTimespan(messages: DbMessage[]): string {
  if (messages.length < 2) return 'just now';
  const oldest = messages[0].timestamp;
  const newest = messages[messages.length - 1].timestamp;
  const diffHours = Math.round((newest - oldest) / 3600);

  if (diffHours < 1) return 'last hour';
  if (diffHours < 24) return `last ${diffHours}h`;
  const diffDays = Math.round(diffHours / 24);
  return `last ${diffDays} day${diffDays !== 1 ? 's' : ''}`;
}
