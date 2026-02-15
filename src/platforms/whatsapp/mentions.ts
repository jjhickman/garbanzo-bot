import { MENTION_PATTERNS } from '../../core/groups-config.js';

/** Extract the bare identifier (without device suffix or domain) from a JID or LID */
function bareId(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Check if the bot is mentioned — either via WhatsApp's native JID-based
 * mention system (contextInfo.mentionedJid) or via text pattern fallback.
 *
 * WhatsApp is migrating to LIDs (Linked IDs) — mentions may arrive as
 * either `phone@s.whatsapp.net` or `lid@lid`. We check both.
 */
export function isMentioned(
  text: string,
  mentionedJids: string[] | undefined,
  botJid: string | undefined,
  botLid: string | undefined,
): boolean {
  // Primary: check WhatsApp's native mention (JID or LID based)
  if (mentionedJids?.length) {
    const botIds = [botJid, botLid]
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => bareId(id));
    if (mentionedJids.some((jid) => botIds.includes(bareId(jid)))) {
      return true;
    }
  }

  // Fallback: text pattern matching (for users who type "@garbanzo" manually)
  const lower = text.toLowerCase();
  return MENTION_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * Strip mention artifacts from the message text.
 * Handles native @mentions (which appear as @phonenumber or @lid) and
 * text-based patterns like "@garbanzo".
 */
export function stripMention(text: string, botJid?: string, botLid?: string): string {
  let result = text;

  // Strip native WhatsApp mention formats (@phonenumber or @lid)
  for (const id of [botJid, botLid].filter((v): v is string => typeof v === 'string' && v.length > 0)) {
    const num = bareId(id);
    const idRegex = new RegExp(`@${num}\\b`, 'g');
    result = result.replace(idRegex, '').trim();
  }

  // Strip text-based patterns
  for (const pattern of MENTION_PATTERNS) {
    const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, '').trim();
  }

  return result;
}
