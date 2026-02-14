import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import {
  type WASocket,
  type WAMessage,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from '../utils/config.js';
import { getGroupName, GROUP_IDS } from '../bot/groups.js';
import { getAIResponse } from '../ai/router.js';
import { getSenderJid } from '../utils/jid.js';

/**
 * Introductions feature — auto-responds to new member introductions
 * posted in the Introductions group. No @mention required.
 *
 * On startup, catches up on any intros from the past 1-7 days that
 * the bot missed (e.g. during downtime or before this feature existed).
 *
 * Uses a simple JSON tracker to avoid double-responding.
 */

// ── Constants ───────────────────────────────────────────────────────

/** Minimum character length to consider a message an introduction */
const MIN_INTRO_LENGTH = 40;

/** Maximum age (in days) to look back for missed intros on catch-up.
 *  Temporarily set to 14 days for initial testing — drop to 7 once verified. */
const CATCHUP_DAYS = 14;

/** Delay between catch-up responses to avoid flooding (ms) */
const CATCHUP_DELAY_MS = 5_000;

/** Path to the tracker file */
const TRACKER_PATH = resolve(PROJECT_ROOT, 'data', 'intro-tracker.json');

// ── Intro JID lookup ────────────────────────────────────────────────

/** Find the Introductions group JID from config */
function getIntroductionsJid(): string | null {
  for (const [jid, cfg] of Object.entries(GROUP_IDS)) {
    if (cfg.name === 'Introductions' && cfg.enabled) {
      return jid;
    }
  }
  return null;
}

export const INTRODUCTIONS_JID = getIntroductionsJid();

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
    logger.warn({ err }, 'Failed to load intro tracker — starting fresh');
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
    logger.error({ err }, 'Failed to save intro tracker');
  }
}

const tracker = loadTracker();

function markResponded(messageId: string): void {
  if (!tracker.respondedIds.includes(messageId)) {
    tracker.respondedIds.push(messageId);
    // Keep tracker from growing forever — only keep last 500 IDs
    if (tracker.respondedIds.length > 500) {
      tracker.respondedIds = tracker.respondedIds.slice(-500);
    }
    saveTracker(tracker);
  }
}

function hasResponded(messageId: string): boolean {
  return tracker.respondedIds.includes(messageId);
}

// ── Intro detection ─────────────────────────────────────────────────

/**
 * Determine if a message looks like a new member introduction.
 *
 * Heuristic: the message is long enough to be a real intro (not just
 * "hi" or "thanks"), and doesn't look like a bot command.
 */
export function looksLikeIntroduction(text: string): boolean {
  const trimmed = text.trim();

  // Too short to be an intro
  if (trimmed.length < MIN_INTRO_LENGTH) return false;

  // Filter out messages that are clearly NOT intros
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('@garbanzo') || lower.startsWith('@bot')) return false;

  return true;
}

// ── Intro-specific AI prompt addendum ───────────────────────────────

export const INTRO_SYSTEM_ADDENDUM = [
  '',
  '--- SPECIAL CONTEXT ---',
  '',
  'A new member just posted their introduction. Your job is to welcome them warmly.',
  'Read what they shared about themselves and respond with:',
  '- A genuine, warm welcome to the community',
  '- A comment or question about something specific they mentioned (shows you actually read it)',
  '- Optionally, a suggestion of which groups they might enjoy based on their interests',
  '',
  'Keep it to 2-4 sentences. Do NOT use a template — make each response feel personal.',
  'Do NOT ask multiple questions — at most one, and only if it flows naturally.',
  'Do NOT list all the groups. Only mention 1-2 that directly match what they shared.',
].join('\n');

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

// ── Startup catch-up ────────────────────────────────────────────────

/**
 * Register a listener for history sync events that Baileys delivers
 * on connection. When messages from the Introductions group arrive
 * via history sync, check for missed intros and respond.
 *
 * Also listens for 'messages.upsert' with type 'append' which Baileys
 * uses to deliver messages received while offline.
 */
export function registerIntroCatchUp(sock: WASocket): void {
  if (!INTRODUCTIONS_JID) {
    logger.warn('Introductions group not found in config — skipping catch-up registration');
    return;
  }

  const cutoffTimestamp = Math.floor(Date.now() / 1000) - (CATCHUP_DAYS * 24 * 60 * 60);

  // Filter function shared by both catch-up paths
  function filterIntroMessages(messages: WAMessage[]): WAMessage[] {
    return messages.filter((msg) => {
      if (msg.key.remoteJid !== INTRODUCTIONS_JID) return false;
      if (msg.key.fromMe) return false;

      const ts = msg.messageTimestamp;
      if (!ts) return false;
      const epochSeconds = typeof ts === 'number' ? ts : Number(ts);
      if (epochSeconds < cutoffTimestamp) return false;

      const messageId = msg.key.id;
      if (!messageId || hasResponded(messageId)) return false;

      const content = normalizeMessageContent(msg.message);
      const text = content?.conversation
        ?? content?.extendedTextMessage?.text
        ?? content?.imageMessage?.caption
        ?? null;

      return text !== null && looksLikeIntroduction(text);
    });
  }

  // Sort oldest-first helper
  function sortOldestFirst(msgs: WAMessage[]): WAMessage[] {
    return msgs.sort((a, b) => {
      const tsA = typeof a.messageTimestamp === 'number' ? a.messageTimestamp : Number(a.messageTimestamp);
      const tsB = typeof b.messageTimestamp === 'number' ? b.messageTimestamp : Number(b.messageTimestamp);
      return tsA - tsB;
    });
  }

  // Path 1: History sync — Baileys delivers batch of historical messages on connect
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    const introMessages = filterIntroMessages(messages);
    if (introMessages.length === 0) return;

    logger.info(
      { count: introMessages.length, source: 'history-sync' },
      'Found missed introductions — responding',
    );
    await processMissedIntros(sock, sortOldestFirst(introMessages));
  });

  // Path 2: messages.upsert with type != 'notify' — Baileys delivers messages
  // received while offline (type 'append') or via protocol sync
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' messages are handled by the real-time handler in handlers.ts
    if (type === 'notify') return;

    const introMessages = filterIntroMessages(messages);
    if (introMessages.length === 0) return;

    logger.info(
      { count: introMessages.length, type, source: 'messages-upsert' },
      'Found missed introductions via message sync — responding',
    );
    await processMissedIntros(sock, sortOldestFirst(introMessages));
  });

  logger.info({ catchupDays: CATCHUP_DAYS }, 'Introduction catch-up listeners registered');
}

/**
 * Process a batch of missed introduction messages.
 * Responds to each with a delay to avoid flooding.
 */
async function processMissedIntros(
  sock: WASocket,
  messages: WAMessage[],
): Promise<void> {
  for (const msg of messages) {
    const content = normalizeMessageContent(msg.message);
    const text = content?.conversation
      ?? content?.extendedTextMessage?.text
      ?? content?.imageMessage?.caption
      ?? '';

    const messageId = msg.key.id!;
    const senderJid = getSenderJid(INTRODUCTIONS_JID!, msg.key.participant);

    const response = await handleIntroduction(text, messageId, senderJid, INTRODUCTIONS_JID!);

    if (response) {
      try {
        await sock.sendMessage(INTRODUCTIONS_JID!, { text: response }, { quoted: msg });
        logger.info({ messageId, sender: senderJid }, 'Catch-up introduction response sent');
      } catch (err) {
        logger.error({ err, messageId }, 'Failed to send catch-up intro response');
      }

      // Delay between responses to avoid flooding
      await sleep(CATCHUP_DELAY_MS);
    }
  }

  tracker.lastCatchup = Date.now();
  saveTracker(tracker);
}

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
