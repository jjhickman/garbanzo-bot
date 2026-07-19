import { logger } from '../middleware/logger.js';
import { getGroupName } from '../core/groups-config.js';
import { bold } from '../utils/formatting.js';

/**
 * New member welcome — sends a friendly greeting when someone joins a group.
 * Tailored per group based on its vibe.
 */

const GROUP_WELCOMES: Record<string, string> = {
  'General': `Welcome to the group! This is the main chat — feel free to jump in on any topic. If you need anything, just @mention me.`,
  'Events': `Welcome! This is where we plan outings, meetups, and activities around Boston. Keep an eye out for upcoming events or propose your own.`,
  'Entertainment': `Welcome! TV, movies, music, gaming — if it's entertainment, it belongs here.`,
  'Hobbies': `Welcome! Share what you're into — crafts, cooking, sports, side projects, whatever keeps you busy.`,
  'Book Club': `Welcome to Book Club! Check the pinned messages for the current pick and join the discussion whenever you're ready.`,
  'Shitposting': `Welcome to the chaos zone. Memes, hot takes, and general nonsense — rules still apply though.`,
  'Introductions': `Welcome! Tell us a bit about yourself — where you're from, what you're into, what brought you here.`,
  'Guild of Musicians': `Welcome! Whether you play, sing, produce, or just love music — you're in the right place.`,
};

const DEFAULT_WELCOME = `Welcome to the group! Feel free to jump in — @mention me if you need anything.`;

export interface WelcomeMessage {
  text: string;
  /**
   * Full participant JIDs for Baileys' contextInfo.mentionedJid. A bare
   * `@<number>` in the text renders literally; WhatsApp only substitutes the
   * member's display name when the JID is also sent in the mentions array.
   */
  mentions: string[];
}

/**
 * Build a welcome message for new members joining a group.
 * Returns null if the group isn't configured for welcomes.
 */
export function buildWelcomeMessage(
  groupJid: string,
  participantJids: string[],
): WelcomeMessage | null {
  const groupName = getGroupName(groupJid);
  if (groupName === 'Unknown Group') return null;

  const welcome = GROUP_WELCOMES[groupName] ?? DEFAULT_WELCOME;
  const count = participantJids.length;

  // Mention new members by phone number
  const mentions = participantJids
    .map((jid) => `@${jid.split('@')[0].split(':')[0]}`)
    .join(', ');

  const greeting = count === 1
    ? `Hey ${mentions}! 🫘`
    : `Hey ${mentions}! 🫘 Welcome, all ${count} of you!`;

  logger.info({ group: groupName, newMembers: count }, 'Welcoming new members');

  return {
    text: `${greeting}\n\n${bold(groupName)}: ${welcome}`,
    mentions: participantJids,
  };
}
