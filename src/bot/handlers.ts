import {
  type WASocket,
  type WAMessage,
  type WAMessageContent,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { isGroupJid, getSenderJid } from '../utils/jid.js';
import { isGroupEnabled, requiresMention, isMentioned, stripMention, getGroupName } from './groups.js';
import { getAIResponse } from '../ai/router.js';
import { matchFeature } from '../features/router.js';
import { handleWeather } from '../features/weather.js';
import { handleTransit } from '../features/transit.js';
import { buildWelcomeMessage } from '../features/welcome.js';
import { checkMessage, formatModerationAlert } from '../features/moderation.js';
import { handleNews } from '../features/news.js';
import { getHelpMessage } from '../features/help.js';
import { handleIntroduction, INTRODUCTIONS_JID, triggerIntroCatchUp } from '../features/introductions.js';

/**
 * Register all message event handlers on the socket.
 * This is the main message routing logic.
 */
export function registerHandlers(sock: WASocket): void {
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

/**
 * Unwrap the message content, handling ephemeral/viewOnce/protocol wrappers
 * that WhatsApp applies in groups with disappearing messages etc.
 */
function unwrapMessage(msg: WAMessage): WAMessageContent | undefined {
  return normalizeMessageContent(msg.message);
}

/** Maximum age (in seconds) for a message to be processed. Older messages are silently ignored. */
const MAX_MESSAGE_AGE_SECONDS = 5 * 60; // 5 minutes

/**
 * Route a single incoming message.
 */
async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
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
  const text = extractText(content);

  logger.debug({
    remoteJid,
    hasMessage: !!msg.message,
    hasContent: !!content,
    hasText: !!text,
    messageKeys: msg.message ? Object.keys(msg.message) : [],
    contentKeys: content ? Object.keys(content) : [],
  }, 'Message received');

  if (!text) return;

  const senderJid = getSenderJid(remoteJid, msg.key.participant);

  // ── Moderation (runs on ALL group messages, not just mentions) ──
  if (isGroupJid(remoteJid) && isGroupEnabled(remoteJid)) {
    const flag = await checkMessage(text);
    if (flag) {
      logger.warn({ group: remoteJid, sender: senderJid, reason: flag.reason, severity: flag.severity, source: flag.source }, 'Moderation flag');
      const alert = formatModerationAlert(flag, text, senderJid, remoteJid);
      try {
        logger.info({ ownerJid: config.OWNER_JID }, 'Sending moderation alert to owner');
        const result = await sock.sendMessage(config.OWNER_JID, { text: alert });
        logger.info({ msgId: result?.key?.id, to: result?.key?.remoteJid }, 'Moderation alert sent');
      } catch (err) {
        logger.error({ err }, 'Failed to send moderation alert to owner');
      }
    }
  }

  // ── Introductions (auto-respond, no @mention needed) ──
  if (remoteJid === INTRODUCTIONS_JID) {
    const messageId = msg.key.id;
    if (messageId) {
      const introResponse = await handleIntroduction(text, messageId, senderJid, remoteJid);
      if (introResponse) {
        await sock.sendMessage(remoteJid, { text: introResponse }, { quoted: msg });
        return; // Intro handled — don't also process as a general message
      }
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

    // Only respond if @mentioned (when group requires it)
    const mentionedJids = extractMentionedJids(content);
    const botJid = sock.user?.id;
    const botLid = sock.user?.lid;

    logger.debug({
      text,
      mentionedJids,
      botJid,
      botLid,
      requiresMention: requiresMention(remoteJid),
      isMentioned: isMentioned(text, mentionedJids, botJid, botLid),
    }, 'Mention check');

    if (requiresMention(remoteJid) && !isMentioned(text, mentionedJids, botJid, botLid)) return;

    const query = stripMention(text, botJid, botLid);
    const groupName = getGroupName(remoteJid);

    logger.info({ group: groupName, sender: senderJid, query }, 'Group mention');

    const response = await getResponse(query, {
      groupName,
      groupJid: remoteJid,
      senderJid,
      quotedText: extractQuotedText(content),
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

    // Owner commands
    if (text.trim().toLowerCase() === '!catchup intros') {
      const result = await triggerIntroCatchUp(sock);
      await sock.sendMessage(remoteJid, { text: result });
      return;
    }

    const response = await getResponse(text, {
      groupName: 'DM',
      groupJid: remoteJid,
      senderJid,
    });

    if (response) {
      await sock.sendMessage(remoteJid, { text: response });
    }
  }
}

/**
 * Try feature-specific handlers first, then fall back to general AI.
 * Features are matched by keyword; if no feature matches, Claude handles it.
 */
async function getResponse(
  query: string,
  ctx: import('../ai/persona.js').MessageContext,
): Promise<string | null> {
  const feature = matchFeature(query);

  if (feature) {
    logger.info({ feature: feature.feature }, 'Routing to feature handler');

    switch (feature.feature) {
      case 'help':
        return getHelpMessage();
      case 'weather':
        return await handleWeather(feature.query);
      case 'transit':
        return await handleTransit(feature.query);
      case 'news':
        return await handleNews(feature.query);
    }
  }

  // No feature matched — general AI response
  return await getAIResponse(query, ctx);
}

/** Extract text content from unwrapped message content */
function extractText(content: WAMessageContent | undefined): string | null {
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
function extractQuotedText(content: WAMessageContent | undefined): string | undefined {
  const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return undefined;
  // The quoted message itself may need unwrapping
  const unwrapped = normalizeMessageContent(quoted);
  return extractText(unwrapped) ?? undefined;
}

/** Extract JIDs mentioned via WhatsApp's native @mention system */
function extractMentionedJids(content: WAMessageContent | undefined): string[] | undefined {
  if (!content) return undefined;
  const ctx = content.extendedTextMessage?.contextInfo
    ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo
    ?? content.documentMessage?.contextInfo;
  const jids = ctx?.mentionedJid;
  if (!jids || jids.length === 0) return undefined;
  return jids;
}

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

// ── Acknowledgment reactions ────────────────────────────────────────

/** Extract the bare identifier from a JID (without device suffix or domain) */
function bareId(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Check if this message is a reply to one of the bot's messages.
 * Looks at contextInfo.participant (who sent the quoted message).
 */
function isReplyToBot(
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
function isAcknowledgment(text: string): boolean {
  const trimmed = text.trim();
  // Must be short (under 30 chars) to be an acknowledgment
  if (trimmed.length > 30) return false;
  return ACKNOWLEDGMENT_PATTERNS.some((p) => p.test(trimmed));
}
