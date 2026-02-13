import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { isGroupJid, getSenderJid } from '../utils/jid.js';
import { isGroupEnabled, requiresMention, isMentioned, stripMention, getGroupName } from './groups.js';
import { getAIResponse } from '../ai/router.js';

/**
 * Register all message event handlers on the socket.
 * This is the main message routing logic.
 */
export function registerHandlers(sock: WASocket): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only process real-time messages, not history sync
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err, msgId: msg.key.id }, 'Error handling message');
      }
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    logger.info(
      { group: update.id, action: update.action, count: update.participants.length },
      'Group participant update',
    );
    // TODO Phase 2: welcome new members when action === 'add'
  });

  logger.info('Message handlers registered');
}

/**
 * Route a single incoming message.
 */
async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  // Ignore messages sent by the bot itself
  if (msg.key.fromMe) return;

  // Ignore status broadcasts
  if (msg.key.remoteJid === 'status@broadcast') return;

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;

  const text = extractText(msg);
  if (!text) return;

  const senderJid = getSenderJid(remoteJid, msg.key.participant);

  // ── Group messages ──
  if (isGroupJid(remoteJid)) {
    if (!isGroupEnabled(remoteJid)) return;

    // Only respond if @mentioned (when group requires it)
    if (requiresMention(remoteJid) && !isMentioned(text)) return;

    const query = stripMention(text);
    const groupName = getGroupName(remoteJid);

    logger.info({ group: groupName, sender: senderJid, query }, 'Group mention');

    const response = await getAIResponse(query, {
      groupName,
      groupJid: remoteJid,
      senderJid,
      quotedText: extractQuotedText(msg),
    });

    if (response) {
      await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });
    }
    return;
  }

  // ── Direct messages ──
  // Only respond to owner DMs for now (Phase 1 safety)
  if (senderJid === config.OWNER_JID) {
    logger.info({ sender: senderJid, text }, 'Owner DM');

    const response = await getAIResponse(text, {
      groupName: 'DM',
      groupJid: remoteJid,
      senderJid,
    });

    if (response) {
      await sock.sendMessage(remoteJid, { text: response });
    }
  }
}

/** Extract text content from various message types */
function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;

  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

/** Extract quoted/replied-to text if present */
function extractQuotedText(msg: WAMessage): string | undefined {
  return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    ?.conversation ?? undefined;
}
