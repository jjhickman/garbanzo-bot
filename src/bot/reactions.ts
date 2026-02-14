import type { WAMessageContent } from '@whiskeysockets/baileys';

/** Extract the bare identifier from a JID (without device suffix or domain) */
function bareId(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Check if this message is a reply to one of the bot's messages.
 * Looks at contextInfo.participant (who sent the quoted message).
 */
export function isReplyToBot(
  content: WAMessageContent | undefined,
  botJid?: string,
  botLid?: string,
): boolean {
  if (!content) return false;
  const ctx = content.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return false;

  const quotedParticipant = ctx.participant;
  if (!quotedParticipant) return false;

  const botIds = [botJid, botLid].filter(Boolean).map((id) => bareId(id!));
  return botIds.includes(bareId(quotedParticipant));
}

/**
 * Short acknowledgment patterns that warrant an emoji reaction
 * instead of a full AI response. Matched case-insensitively.
 */
const ACKNOWLEDGMENT_PATTERNS = [
  /^good bot\b/i,
  /^bad bot\b/i,
  /^thanks?\b/i,
  /^thank you\b/i,
  /^ty\b/i,
  /^thx\b/i,
  /^nice\b/i,
  /^cool\b/i,
  /^awesome\b/i,
  /^great\b/i,
  /^perfect\b/i,
  /^👍/,
  /^❤️/,
  /^🙏/,
  /^😂/,
  /^lol\b/i,
  /^lmao\b/i,
  /^haha\b/i,
  /^ok\b/i,
  /^okay\b/i,
  /^bet\b/i,
  /^word\b/i,
  /^dope\b/i,
];

/** Check if a message is a short acknowledgment */
export function isAcknowledgment(text: string): boolean {
  const trimmed = text.trim();
  // Must be short (under 30 chars) to be an acknowledgment
  if (trimmed.length > 30) return false;
  return ACKNOWLEDGMENT_PATTERNS.some((p) => p.test(trimmed));
}
