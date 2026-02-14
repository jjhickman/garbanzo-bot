/**
 * Rate limiting — sliding window per-user and per-group.
 *
 * Prevents abuse without blocking legitimate use. Limits apply to
 * bot responses only (not passive message observation).
 *
 * Defaults:
 * - Per-user: 10 bot responses per 5 minutes
 * - Per-group: 30 bot responses per 5 minutes
 * - Owner is exempt from rate limits
 */

import { logger } from './logger.js';
import { config } from '../utils/config.js';

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const USER_LIMIT = 10;
const GROUP_LIMIT = 30;

/** Timestamps of recent bot responses */
const userWindows = new Map<string, number[]>();
const groupWindows = new Map<string, number[]>();

/** Prune expired timestamps from a window */
function prune(window: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  // Find first index that's still within the window
  let i = 0;
  while (i < window.length && window[i] < cutoff) i++;
  return i > 0 ? window.slice(i) : window;
}

/**
 * Check if a response is allowed under rate limits.
 * Returns null if allowed, or a rejection message if rate-limited.
 *
 * Call this BEFORE generating the AI response.
 */
export function checkRateLimit(
  senderJid: string,
  groupJid: string,
): string | null {
  // Owner is exempt
  if (senderJid === config.OWNER_JID) return null;

  const now = Date.now();

  // Check per-user limit
  let userWindow = userWindows.get(senderJid) ?? [];
  userWindow = prune(userWindow, now);
  userWindows.set(senderJid, userWindow);

  if (userWindow.length >= USER_LIMIT) {
    logger.warn({ senderJid, count: userWindow.length, limit: USER_LIMIT }, 'User rate limited');
    return `🫘 Easy there — I can only handle ${USER_LIMIT} questions per 5 minutes. Give me a sec to catch up.`;
  }

  // Check per-group limit
  let groupWindow = groupWindows.get(groupJid) ?? [];
  groupWindow = prune(groupWindow, now);
  groupWindows.set(groupJid, groupWindow);

  if (groupWindow.length >= GROUP_LIMIT) {
    logger.warn({ groupJid, count: groupWindow.length, limit: GROUP_LIMIT }, 'Group rate limited');
    return `🫘 This group's been keeping me busy — hit the limit of ${GROUP_LIMIT} responses per 5 minutes. I'll be back shortly.`;
  }

  return null;
}

/**
 * Record that a bot response was sent. Call AFTER sending the response.
 */
export function recordResponse(senderJid: string, groupJid: string): void {
  const now = Date.now();

  const userWindow = userWindows.get(senderJid) ?? [];
  userWindow.push(now);
  userWindows.set(senderJid, userWindow);

  const groupWindow = groupWindows.get(groupJid) ?? [];
  groupWindow.push(now);
  groupWindows.set(groupJid, groupWindow);
}
