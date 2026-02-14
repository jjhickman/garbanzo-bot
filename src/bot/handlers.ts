import {
  type WASocket,
  type WAMessage,
  type WAMessageContent,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { isGroupJid, getSenderJid } from '../utils/jid.js';
import { isGroupEnabled, getGroupName } from './groups.js';
import { buildWelcomeMessage } from '../features/welcome.js';
import { checkMessage, formatModerationAlert, applyStrikeAndMute } from '../features/moderation.js';
import { handleIntroduction, INTRODUCTIONS_JID } from '../features/introductions.js';
import { handleEventPassive, EVENTS_JID } from '../features/events.js';
import { sanitizeMessage } from '../middleware/sanitize.js';
import { touchProfile, updateActiveGroups, logModeration } from '../utils/db.js';
import { recordMessage } from '../middleware/context.js';
import { recordGroupMessage, recordModerationFlag, recordBotResponse } from '../middleware/stats.js';
import { setRetryHandler, type RetryEntry } from '../middleware/retry.js';
import { isVoiceMessage, downloadVoiceAudio, hasVisualMedia } from '../features/media.js';
import { transcribeAudio } from '../features/voice.js';
import { markMessageReceived } from '../middleware/health.js';
import { handleOwnerDM } from './owner-commands.js';
import { handleGroupMessage } from './group-handler.js';
import { isReplyToBot, isAcknowledgment } from './reactions.js';

// Re-export getResponse for owner-commands + group-handler; also used by retry handler below
export { getResponse } from './response-router.js';
import { getResponse } from './response-router.js';

/**
 * Register all message event handlers on the socket.
 * This is the main message routing logic.
 */
export function registerHandlers(sock: WASocket): void {
  // Register retry handler — retries send the AI response directly
  setRetryHandler(async (entry: RetryEntry) => {
    const groupName = getGroupName(entry.groupJid);
    const response = await getResponse(entry.query, {
      groupName,
      groupJid: entry.groupJid,
      senderJid: entry.senderJid,
    });
    if (response) {
      await sock.sendMessage(entry.groupJid, { text: response });
      recordBotResponse(entry.groupJid);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        // Process all message types for the Introductions group (catch-up path),
        // but only real-time ('notify') messages for everything else.
        const isIntroGroup = msg.key.remoteJid === INTRODUCTIONS_JID;
        if (type !== 'notify' && !isIntroGroup) continue;

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

    if (update.action === 'add' && isGroupEnabled(update.id)) {
      const welcome = buildWelcomeMessage(update.id, update.participants);
      if (welcome) {
        try {
          await sock.sendMessage(update.id, { text: welcome });
        } catch (err) {
          logger.error({ err, group: update.id }, 'Failed to send welcome message');
        }
      }
    }
  });

  logger.info('Message handlers registered');
}

// ── Shared helpers (exported for use by owner-commands.ts and group-handler.ts) ──

/**
 * Unwrap the message content, handling ephemeral/viewOnce/protocol wrappers
 * that WhatsApp applies in groups with disappearing messages etc.
 */
function unwrapMessage(msg: WAMessage): WAMessageContent | undefined {
  return normalizeMessageContent(msg.message);
}

/** Extract text content from unwrapped message content */
export function extractText(content: WAMessageContent | undefined): string | null {
  if (!content) return null;

  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null
  );
}

/** Extract quoted/replied-to text if present */
export function extractQuotedText(content: WAMessageContent | undefined): string | undefined {
  const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return undefined;
  // The quoted message itself may need unwrapping
  const unwrapped = normalizeMessageContent(quoted);
  return extractText(unwrapped) ?? undefined;
}

/** Extract JIDs mentioned via WhatsApp's native @mention system */
export function extractMentionedJids(content: WAMessageContent | undefined): string[] | undefined {
  if (!content) return undefined;
  const ctx = content.extendedTextMessage?.contextInfo
    ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo
    ?? content.documentMessage?.contextInfo;
  const jids = ctx?.mentionedJid;
  if (!jids || jids.length === 0) return undefined;
  return jids;
}

// ── Message routing (private) ───────────────────────────────────────

/** Maximum age (in seconds) for a message to be processed. Older messages are silently ignored. */
const MAX_MESSAGE_AGE_SECONDS = 5 * 60; // 5 minutes

/**
 * Route a single incoming message.
 */
async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  // Track message freshness for staleness detection
  markMessageReceived();

  // Ignore messages sent by the bot itself
  if (msg.key.fromMe) return;

  // Ignore status broadcasts
  if (msg.key.remoteJid === 'status@broadcast') return;

  // Ignore stale messages (e.g. delivered after bot was offline for a while)
  // Exception: Introductions group — intros are caught up via dedup tracker
  const isIntroGroupMsg = msg.key.remoteJid === INTRODUCTIONS_JID;
  if (isStale(msg) && !isIntroGroupMsg) return;

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;

  const content = unwrapMessage(msg);
  let rawText = extractText(content);

  logger.debug({
    remoteJid,
    hasMessage: !!msg.message,
    hasContent: !!content,
    hasText: !!rawText,
    messageKeys: msg.message ? Object.keys(msg.message) : [],
    contentKeys: content ? Object.keys(content) : [],
  }, 'Message received');

  // ── Voice message transcription ──
  // If it's a voice note, transcribe it and use the transcript as the message text.
  const isVoice = isVoiceMessage(msg);
  if (isVoice) {
    const audioBuffer = await downloadVoiceAudio(msg);
    if (audioBuffer) {
      const transcript = await transcribeAudio(audioBuffer, 'audio/ogg');
      if (transcript) {
        logger.info({ transcriptLen: transcript.length }, 'Voice message transcribed');
        rawText = transcript;
      } else {
        logger.debug('Voice message transcription failed — skipping');
        return;
      }
    } else {
      return;
    }
  }

  // Allow messages with visual media through even without text (e.g. image-only)
  const hasMedia = hasVisualMedia(msg);
  if (!rawText && !hasMedia) return;

  // ── Input sanitization ──
  const sanitized = sanitizeMessage(rawText ?? '');
  if (sanitized.rejected) {
    logger.debug({ reason: sanitized.rejectionReason }, 'Message rejected by sanitizer');
    return;
  }
  const text = sanitized.text;

  const senderJid = getSenderJid(remoteJid, msg.key.participant);

  // ── Record message for conversation context + stats + profile ──
  recordMessage(remoteJid, senderJid, text);
  if (isGroupJid(remoteJid)) {
    recordGroupMessage(remoteJid, senderJid);
    // Passive profile tracking — update first/last seen and active groups
    touchProfile(senderJid);
    updateActiveGroups(senderJid, remoteJid);
  }

  // ── Moderation (runs on ALL group messages, not just mentions) ──
  if (isGroupJid(remoteJid) && isGroupEnabled(remoteJid)) {
    const flag = await checkMessage(text);
    if (flag) {
      recordModerationFlag(remoteJid);
      logModeration({
        chatJid: remoteJid,
        sender: senderJid,
        text: text.slice(0, 500),
        reason: flag.reason,
        severity: flag.severity,
        source: flag.source,
        timestamp: Math.floor(Date.now() / 1000),
      });
      logger.warn({ group: remoteJid, sender: senderJid, reason: flag.reason, severity: flag.severity, source: flag.source }, 'Moderation flag');
      const alert = formatModerationAlert(flag, text, senderJid, remoteJid);
      try {
        logger.info({ ownerJid: config.OWNER_JID }, 'Sending moderation alert to owner');
        const result = await sock.sendMessage(config.OWNER_JID, { text: alert });
        logger.info({ msgId: result?.key?.id, to: result?.key?.remoteJid }, 'Moderation alert sent');
      } catch (err) {
        logger.error({ err }, 'Failed to send moderation alert to owner');
      }

      // Apply strike and soft-mute if threshold reached
      const { muted, dmMessage } = applyStrikeAndMute(senderJid);
      if (muted && dmMessage) {
        try {
          await sock.sendMessage(senderJid, { text: dmMessage });
          logger.info({ senderJid }, 'Soft-mute DM sent to user');
        } catch (err) {
          logger.error({ err, senderJid }, 'Failed to send soft-mute DM');
        }
      }
    }
  }

  // ── Introductions (auto-respond, no @mention needed) ──
  if (remoteJid === INTRODUCTIONS_JID) {
    const isReply = !!content?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!isReply) {
      const messageId = msg.key.id;
      if (messageId) {
        const introResponse = await handleIntroduction(text, messageId, senderJid, remoteJid);
        if (introResponse) {
          await sock.sendMessage(remoteJid, { text: introResponse }, { quoted: msg });
          return; // Intro handled — don't also process as a general message
        }
      }
    }
  }

  // ── Events group (passive detection, no @mention needed) ──
  if (remoteJid === EVENTS_JID) {
    const eventResponse = await handleEventPassive(text, senderJid, remoteJid);
    if (eventResponse) {
      await sock.sendMessage(remoteJid, { text: eventResponse }, { quoted: msg });
      return;
    }
  }

  // ── Emoji reactions to bot replies (acknowledgments) ──
  if (isReplyToBot(content, sock.user?.id, sock.user?.lid) && isAcknowledgment(text)) {
    logger.info({ remoteJid, sender: senderJid, text }, 'Acknowledgment reply — reacting');
    try {
      await sock.sendMessage(remoteJid, {
        react: { text: '🫘', key: msg.key },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to send reaction');
    }
    return;
  }

  // ── Group messages ──
  if (isGroupJid(remoteJid)) {
    if (!isGroupEnabled(remoteJid)) return;
    await handleGroupMessage(sock, msg, remoteJid, senderJid, text, content, hasMedia);
    return;
  }

  // ── Direct messages ──
  // Only respond to owner DMs for now (Phase 1 safety)
  await handleOwnerDM(sock, remoteJid, senderJid, text);
}

// ── Staleness check ─────────────────────────────────────────────────

/**
 * Check if a message is too old to process.
 * Prevents the bot from replying to stale mentions delivered after
 * an outage (e.g., "what's the weather?" asked 3 hours ago).
 */
function isStale(msg: WAMessage): boolean {
  const ts = msg.messageTimestamp;
  if (!ts) return false; // No timestamp — treat as fresh

  const epochSeconds = typeof ts === 'number' ? ts : Number(ts);
  const ageSeconds = Math.floor(Date.now() / 1000) - epochSeconds;

  if (ageSeconds > MAX_MESSAGE_AGE_SECONDS) {
    logger.debug({ ageSeconds, msgId: msg.key.id }, 'Ignoring stale message');
    return true;
  }
  return false;
}


