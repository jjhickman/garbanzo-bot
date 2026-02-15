import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { normalizeMessageContent } from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import { getSenderJid } from '../../utils/jid.js';
import {
  INTRODUCTIONS_JID,
  handleIntroduction,
  looksLikeIntroduction,
  hasResponded,
  markCatchupComplete,
} from '../../features/introductions.js';

/** Maximum age (in days) to look back for missed intros on catch-up. */
const CATCHUP_DAYS = 14;

/** Delay between catch-up responses to avoid flooding (ms) */
const CATCHUP_DELAY_MS = 5_000;

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

  const groupJid = INTRODUCTIONS_JID;
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - (CATCHUP_DAYS * 24 * 60 * 60);

  function filterIntroMessages(messages: WAMessage[]): WAMessage[] {
    return messages.filter((msg) => {
      if (msg.key.remoteJid !== groupJid) return false;
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

  function sortOldestFirst(msgs: WAMessage[]): WAMessage[] {
    return msgs.sort((a, b) => {
      const tsA = typeof a.messageTimestamp === 'number' ? a.messageTimestamp : Number(a.messageTimestamp);
      const tsB = typeof b.messageTimestamp === 'number' ? b.messageTimestamp : Number(b.messageTimestamp);
      return tsA - tsB;
    });
  }

  sock.ev.on('messaging-history.set', async ({ messages }) => {
    const introMessages = filterIntroMessages(messages);
    if (introMessages.length === 0) return;

    logger.info(
      { count: introMessages.length, source: 'history-sync' },
      'Found missed introductions — responding',
    );

    await processMissedIntros(sock, groupJid, sortOldestFirst(introMessages));
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' messages are handled by the real-time handler
    if (type === 'notify') return;

    const introMessages = filterIntroMessages(messages);
    if (introMessages.length === 0) return;

    logger.info(
      { count: introMessages.length, type, source: 'messages-upsert' },
      'Found missed introductions via message sync — responding',
    );

    await processMissedIntros(sock, groupJid, sortOldestFirst(introMessages));
  });

  // Actively request message history from the Introductions group.
  const HISTORY_REQUEST_DELAY_MS = 5_000;
  setTimeout(async () => {
    try {
      logger.info({ group: groupJid }, 'Requesting Introductions group message history');
      await sock.fetchMessageHistory(
        50,
        { remoteJid: groupJid, fromMe: false, id: '' },
        Math.floor(Date.now() / 1000),
      );
    } catch (err) {
      logger.warn({ err, groupJid }, 'Failed to request message history — catch-up will rely on passive sync');
    }
  }, HISTORY_REQUEST_DELAY_MS);

  logger.info({ catchupDays: CATCHUP_DAYS }, 'Introduction catch-up listeners registered');
}

/**
 * Manually trigger an introduction catch-up. Called via owner DM
 * command "!catchup intros". Requests message history and reports back.
 */
export async function triggerIntroCatchUp(sock: WASocket): Promise<string> {
  if (!INTRODUCTIONS_JID) {
    return 'Introductions group not found in config.';
  }

  try {
    logger.info('Owner triggered manual intro catch-up');
    await sock.fetchMessageHistory(
      50,
      { remoteJid: INTRODUCTIONS_JID, fromMe: false, id: '' },
      Math.floor(Date.now() / 1000),
    );
    return '🫘 Requested message history for the Introductions group. Any missed intros will be processed as they arrive (may take a few seconds).';
  } catch (err) {
    logger.error({ err, groupJid: INTRODUCTIONS_JID }, 'Manual intro catch-up failed');
    return '❌ Failed to request message history. Check the logs.';
  }
}

async function processMissedIntros(sock: WASocket, groupJid: string, messages: WAMessage[]): Promise<void> {
  for (const msg of messages) {
    const content = normalizeMessageContent(msg.message);
    const text = content?.conversation
      ?? content?.extendedTextMessage?.text
      ?? content?.imageMessage?.caption
      ?? '';

    const messageId = msg.key.id;
    if (!messageId) continue;

    const senderJid = getSenderJid(groupJid, msg.key.participant);
    const response = await handleIntroduction(text, messageId, senderJid, groupJid);

    if (response) {
      try {
        await sock.sendMessage(groupJid, { text: response }, { quoted: msg });
        logger.info({ messageId, sender: senderJid }, 'Catch-up introduction response sent');
      } catch (err) {
        logger.error({ err, messageId }, 'Failed to send catch-up intro response');
      }

      await sleep(CATCHUP_DELAY_MS);
    }
  }

  markCatchupComplete();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
