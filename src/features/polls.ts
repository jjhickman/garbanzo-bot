/**
 * Polls — create native WhatsApp polls via Baileys.
 *
 * Two modes:
 * 1. Explicit: !poll "Question?" "Option 1" "Option 2" "Option 3"
 * 2. Simple:   !poll Question? / Option 1 / Option 2 / Option 3
 *
 * Returns a poll message object for Baileys to send natively.
 * WhatsApp handles voting, tallying, and display — no SQLite needed.
 */

import { logger } from '../middleware/logger.js';
import { bold } from '../utils/formatting.js';

// ── Recent poll dedup ───────────────────────────────────────────────

const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface RecentPoll {
  normalized: string;
  timestamp: number;
}

/** Per-group recent polls: groupJid → array of recent poll questions */
const recentPolls = new Map<string, RecentPoll[]>();

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Check if a similar poll was posted recently in this group */
export function isDuplicatePoll(groupJid: string, question: string): boolean {
  const polls = recentPolls.get(groupJid);
  if (!polls) return false;

  const now = Date.now();
  const norm = normalize(question);

  // Prune expired polls
  const active = polls.filter((p) => now - p.timestamp < DEDUP_WINDOW_MS);
  recentPolls.set(groupJid, active);

  // Check for similar question (exact normalized match or high overlap)
  return active.some((p) => {
    if (p.normalized === norm) return true;
    // Check if one contains the other (catches minor rewording)
    if (norm.includes(p.normalized) || p.normalized.includes(norm)) return true;
    return false;
  });
}

/** Record a poll as recently created */
export function recordPoll(groupJid: string, question: string): void {
  const entry = {
    normalized: normalize(question),
    timestamp: Date.now(),
  };

  const existing = recentPolls.get(groupJid);
  if (existing) {
    existing.push(entry);
    return;
  }

  recentPolls.set(groupJid, [entry]);
}

export interface PollData {
  name: string;
  values: string[];
  selectableCount: number;
}

/**
 * Parse a poll command into question + options.
 *
 * Supported formats:
 * - Quoted: "What day?" "Friday" "Saturday" "Sunday"
 * - Slash-separated: What day? / Friday / Saturday / Sunday
 * - Newline-separated: What day?\nFriday\nSaturday\nSunday
 */
export function parsePoll(input: string): PollData | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let question: string;
  let options: string[];

  // Try quoted format: "question" "opt1" "opt2"
  const quotedParts = trimmed.match(/"([^"]+)"/g);
  if (quotedParts && quotedParts.length >= 3) {
    const cleaned = quotedParts.map((p) => p.replace(/^"|"$/g, '').trim());
    question = cleaned[0];
    options = cleaned.slice(1);
  }
  // Try slash-separated: question / opt1 / opt2
  else if (trimmed.includes('/')) {
    const parts = trimmed.split('/').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    question = parts[0];
    options = parts.slice(1);
  }
  // Try newline-separated
  else if (trimmed.includes('\n')) {
    const parts = trimmed.split('\n').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    question = parts[0];
    options = parts.slice(1);
  }
  else {
    return null;
  }

  // Validate
  if (!question || options.length < 2) return null;
  if (options.length > 12) options = options.slice(0, 12); // WhatsApp limit

  // Clean up question — ensure it ends with ?
  if (!question.endsWith('?')) question += '?';

  return {
    name: question,
    values: options,
    selectableCount: 1, // Single-select by default
  };
}

/**
 * Handle the !poll command. Returns either a PollData to send as a native poll,
 * or a string error/help message.
 */
export function handlePoll(query: string): PollData | string {
  if (!query.trim()) return getPollHelp();

  // Check for multi-select flag
  let input = query;
  let multi = false;
  if (/^multi\s+/i.test(input)) {
    multi = true;
    input = input.replace(/^multi\s+/i, '');
  }

  const poll = parsePoll(input);
  if (!poll) {
    return [
      '🗳️ Couldn\'t parse that poll. Try one of these formats:',
      '',
      '  !poll What day? / Friday / Saturday / Sunday',
      '  !poll "What day?" "Friday" "Saturday" "Sunday"',
      '',
      `_Need 1 question + at least 2 options (max 12)._`,
    ].join('\n');
  }

  if (multi) {
    poll.selectableCount = 0; // 0 = unlimited selections in WhatsApp
  }

  logger.info({ question: poll.name, options: poll.values.length, multi }, 'Creating poll');
  return poll;
}

function getPollHelp(): string {
  return [
    `🗳️ ${bold('Create a Poll')}`,
    '',
    '  !poll What day? / Friday / Saturday / Sunday',
    '  !poll "Best pizza?" "Regina" "Santarpio" "Pepe\'s"',
    '  !poll multi Pick activities / Bowling / Trivia / Karaoke',
    '',
    '_WhatsApp handles voting natively. Max 12 options._',
  ].join('\n');
}
