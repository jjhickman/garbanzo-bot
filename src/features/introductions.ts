import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from '../utils/config.js';
import { getGroupName, getEnabledGroupJidByName } from '../bot/groups.js';
import { getAIResponse } from '../ai/router.js';
import { looksLikeIntroduction } from './intro-classifier.js';

// Re-export classifier symbols so existing importers don't break
export { looksLikeIntroduction, INTRO_SYSTEM_ADDENDUM } from './intro-classifier.js';

/**
 * Introductions feature — auto-responds to new member introductions
 * posted in the Introductions group. No @mention required.
 *
 * On startup, catches up on any intros from the past 1-7 days that
 * the bot missed (e.g. during downtime or before this feature existed).
 *
 * Uses a simple JSON tracker to avoid double-responding.
 * Classification logic lives in intro-classifier.ts.
 */

// ── Constants ───────────────────────────────────────────────────────

/** Path to the tracker file */
const TRACKER_PATH = resolve(PROJECT_ROOT, 'data', 'intro-tracker.json');

// ── Intro JID lookup ────────────────────────────────────────────────

export const INTRODUCTIONS_JID = getEnabledGroupJidByName('Introductions');

// ── Tracker (persisted set of message IDs we've responded to) ───────

interface TrackerData {
  /** Message IDs we've already responded to */
  respondedIds: string[];
  /** Timestamp of last catch-up run */
  lastCatchup: number | null;
}

function loadTracker(): TrackerData {
  try {
    if (existsSync(TRACKER_PATH)) {
      const raw = readFileSync(TRACKER_PATH, 'utf-8');
      return JSON.parse(raw) as TrackerData;
    }
  } catch (err) {
    logger.warn({ err, trackerPath: TRACKER_PATH }, 'Failed to load intro tracker — starting fresh');
  }
  return { respondedIds: [], lastCatchup: null };
}

function saveTracker(data: TrackerData): void {
  try {
    const dir = resolve(PROJECT_ROOT, 'data');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(TRACKER_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error({ err, trackerPath: TRACKER_PATH }, 'Failed to save intro tracker');
  }
}

const tracker = loadTracker();

export function markCatchupComplete(): void {
  tracker.lastCatchup = Date.now();
  saveTracker(tracker);
}

export function markResponded(messageId: string): void {
  if (!tracker.respondedIds.includes(messageId)) {
    tracker.respondedIds.push(messageId);
    // Keep tracker from growing forever — only keep last 500 IDs
    if (tracker.respondedIds.length > 500) {
      tracker.respondedIds = tracker.respondedIds.slice(-500);
    }
    saveTracker(tracker);
  }
}

export function hasResponded(messageId: string): boolean {
  return tracker.respondedIds.includes(messageId);
}

// ── Real-time handler ───────────────────────────────────────────────

/**
 * Handle a potential introduction message. Called from handlers.ts
 * for every message in the Introductions group.
 *
 * Returns the response text if it's an intro we should respond to,
 * null otherwise.
 */
export async function handleIntroduction(
  text: string,
  messageId: string,
  senderJid: string,
  groupJid: string,
): Promise<string | null> {
  if (!looksLikeIntroduction(text)) return null;
  if (hasResponded(messageId)) return null;

  logger.info({ messageId, sender: senderJid }, 'Detected new introduction');

  const response = await getAIResponse(text, {
    groupName: getGroupName(groupJid),
    groupJid,
    senderJid,
  });

  if (response) {
    markResponded(messageId);
  }

  return response;
}

