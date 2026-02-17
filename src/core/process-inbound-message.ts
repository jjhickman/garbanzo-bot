import { logger } from '../middleware/logger.js';
import { checkMessage, formatModerationAlert, applyStrikeAndMute } from '../features/moderation.js';
import { sanitizeMessage } from '../middleware/sanitize.js';
import { touchProfile, updateActiveGroups, logModeration, getStrikeCount } from '../utils/db.js';
import { recordMessage } from '../middleware/context.js';
import { recordGroupMessage, recordModerationFlag } from '../middleware/stats.js';
import type { InboundMessage } from './inbound-message.js';
import type { MessagingAdapter } from './messaging-adapter.js';

/** Maximum age (in seconds) for a message to be processed. */
const MAX_MESSAGE_AGE_SECONDS = 5 * 60; // 5 minutes

export interface CoreMessageHooks {
  /** Return true when the inbound message is a reply to the bot (platform-specific). */
  isReplyToBot(inbound: InboundMessage): boolean;

  /** Return true when the text is a lightweight acknowledgment (e.g., thanks). */
  isAcknowledgment(text: string): boolean;

  /** Send a bean reaction (platform-specific). */
  sendAcknowledgmentReaction(inbound: InboundMessage): Promise<void>;

  /** Continue into platform-specific group handling (mentions, polls, media, etc.). */
  handleGroupMessage(params: {
    inbound: InboundMessage;
    text: string;
    hasMedia: boolean;
  }): Promise<void>;

  /** Continue into platform-specific owner DM handling. */
  handleOwnerDM(params: {
    inbound: InboundMessage;
    text: string;
  }): Promise<void>;
}

/**
 * Core inbound message processing.
 *
 * This module contains the platform-agnostic pipeline steps:
 * - transport guards (self/status/stale)
 * - sanitization
 * - persistence (context + profiles + stats)
 * - moderation + owner escalation
 * - passive intro/event handling
 * - acknowledgment reactions
 * - dispatch to platform-specific handlers
 */
export interface CoreInboundEnv {
  ownerId: string;
  isGroupEnabled: (chatId: string) => boolean;

  introductionsChatId: string | null;
  eventsChatId: string | null;

  handleIntroduction: (text: string, messageId: string, senderId: string, chatId: string) => Promise<string | null>;
  handleEventPassive: (text: string, senderId: string, chatId: string) => Promise<string | null>;
}

export async function processInboundMessage(
  adapter: MessagingAdapter,
  inbound: InboundMessage,
  hooks: CoreMessageHooks,
  env: CoreInboundEnv,
): Promise<void> {
  // Ignore messages sent by the bot itself
  if (inbound.fromSelf) return;

  // Ignore status broadcasts
  if (inbound.isStatusBroadcast) return;

  // Ignore stale messages (delivered long after being sent)
  // Exception: Introductions group — intros are caught up via dedup tracker
  const ageSeconds = Math.floor((Date.now() - inbound.timestampMs) / 1000);
  const isIntroductionsGroup = !!env.introductionsChatId && inbound.chatId === env.introductionsChatId;
  if (ageSeconds > MAX_MESSAGE_AGE_SECONDS && !isIntroductionsGroup) {
    logger.debug({ ageSeconds, msgId: inbound.messageId }, 'Ignoring stale message');
    return;
  }

  // Allow messages with visual media through even without text
  const hasMedia = inbound.hasVisualMedia;
  if (!inbound.text && !hasMedia) return;

  // Input sanitization
  const sanitized = sanitizeMessage(inbound.text ?? '');
  if (sanitized.rejected) {
    logger.debug({ reason: sanitized.rejectionReason }, 'Message rejected by sanitizer');
    return;
  }
  const text = sanitized.text;

  // Record message for conversation context + stats + profile
  await recordMessage(inbound.chatId, inbound.senderId, text);
  if (inbound.isGroupChat) {
    recordGroupMessage(inbound.chatId, inbound.senderId);
    await touchProfile(inbound.senderId);
    await updateActiveGroups(inbound.senderId, inbound.chatId);
  }

  // Moderation (runs on ALL enabled group messages)
  if (inbound.isGroupChat && env.isGroupEnabled(inbound.chatId)) {
    const flag = await checkMessage(text);
    if (flag) {
      recordModerationFlag(inbound.chatId);
      await logModeration({
        chatJid: inbound.chatId,
        sender: inbound.senderId,
        text: text.slice(0, 500),
        reason: flag.reason,
        severity: flag.severity,
        source: flag.source,
        timestamp: Math.floor(Date.now() / 1000),
      });

      logger.warn({ group: inbound.chatId, sender: inbound.senderId, reason: flag.reason, severity: flag.severity, source: flag.source }, 'Moderation flag');

      const strikeCount = await getStrikeCount(inbound.senderId);
      const alert = formatModerationAlert(flag, text, inbound.senderId, inbound.chatId, strikeCount);
      try {
        await adapter.sendText(env.ownerId, alert);
      } catch (err) {
        logger.error({ err, ownerId: env.ownerId, groupJid: inbound.chatId, senderJid: inbound.senderId }, 'Failed to send moderation alert to owner');
      }

      // Apply strike and soft-mute if threshold reached
      const { muted, dmMessage } = applyStrikeAndMute(inbound.senderId, strikeCount);
      if (muted && dmMessage) {
        try {
          await adapter.sendText(inbound.senderId, dmMessage);
          logger.info({ senderJid: inbound.senderId }, 'Soft-mute DM sent to user');
        } catch (err) {
          logger.error({ err, senderJid: inbound.senderId }, 'Failed to send soft-mute DM');
        }
      }
    }
  }

  // Introductions (auto-respond, no @mention needed)
  if (env.introductionsChatId && inbound.chatId === env.introductionsChatId) {
    const isReply = !!inbound.quotedText;
    if (!isReply) {
      const messageId = inbound.messageId;
      if (messageId) {
        const introResponse = await env.handleIntroduction(text, messageId, inbound.senderId, inbound.chatId);
        if (introResponse) {
          await adapter.sendText(inbound.chatId, introResponse, { replyTo: inbound.raw });
          return;
        }
      }
    }
  }

  // Events group (passive detection, no @mention needed)
  if (env.eventsChatId && inbound.chatId === env.eventsChatId) {
    const eventResponse = await env.handleEventPassive(text, inbound.senderId, inbound.chatId);
    if (eventResponse) {
      await adapter.sendText(inbound.chatId, eventResponse, { replyTo: inbound.raw });
      return;
    }
  }

  // Emoji reaction to acknowledgment replies
  if (hooks.isReplyToBot(inbound) && hooks.isAcknowledgment(text)) {
    logger.info({ remoteJid: inbound.chatId, sender: inbound.senderId, text }, 'Acknowledgment reply — reacting');
    try {
      await hooks.sendAcknowledgmentReaction(inbound);
    } catch (err) {
      logger.error({ err, remoteJid: inbound.chatId, senderJid: inbound.senderId, msgId: inbound.messageId }, 'Failed to send reaction');
    }
    return;
  }

  // Dispatch
  if (inbound.isGroupChat) {
    if (!env.isGroupEnabled(inbound.chatId)) return;
    await hooks.handleGroupMessage({ inbound, text, hasMedia });
    return;
  }

  await hooks.handleOwnerDM({ inbound, text });
}
