import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { processInboundMessage } from '../../core/process-inbound-message.js';
import { processGroupMessage } from '../../core/process-group-message.js';
import { getResponse } from '../../core/response-router.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import { createMessageRef } from '../../core/message-ref.js';
import { captureForBridge } from '../../bridge/capture-hook.js';

import type { TelegramInbound } from './inbound.js';
import {
  getTelegramChatName,
  isTelegramChatEnabled,
  isTelegramFeatureEnabled,
  telegramChatRequiresMention,
} from './telegram-config.js';

const TelegramAudioSchema = z.object({
  url: z.string(),
  contentType: z.string(),
  buffer: z.instanceof(Buffer).optional(),
});

const TelegramEventSchema = z.object({
  messageId: z.string(),
  chatId: z.string(),
  isGroupChat: z.boolean(),
  text: z.string().default(''),
  senderId: z.string(),
  senderName: z.string().optional(),
  timestampMs: z.number(),
  quotedText: z.string().optional(),
  fromSelf: z.boolean().default(false),
  mentionedIds: z.array(z.string()).optional(),
  audio: TelegramAudioSchema.optional(),
});

type TelegramEvent = z.infer<typeof TelegramEventSchema>;
type TelegramChannelEnabled = (chatId: string) => boolean;

function normalizeTelegramInbound(event: TelegramEvent): TelegramInbound {
  return {
    platform: 'telegram',
    chatId: event.chatId,
    chatName: getTelegramChatName(event.chatId),
    senderId: event.senderId,
    senderName: event.senderName,
    messageId: event.messageId,
    fromSelf: event.fromSelf,
    isStatusBroadcast: false,
    isGroupChat: event.isGroupChat,
    timestampMs: event.timestampMs,
    text: event.text,
    quotedText: event.quotedText,
    mentionedIds: event.mentionedIds,
    hasVisualMedia: false,
    audio: event.audio,
    raw: createMessageRef({
      platform: 'telegram',
      chatId: event.chatId,
      id: event.messageId,
      ref: {
        kind: 'telegram-inbound',
        chatId: event.chatId,
        messageId: event.messageId,
      },
    }),
  };
}

function buildTelegramMentionRegex(botUsername: string | undefined): RegExp | null {
  if (!botUsername || botUsername.trim().length === 0) return null;
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^@${escaped}[:\\s]*`, 'i');
}

async function processTelegramInbound(
  messenger: PlatformMessenger,
  inbound: TelegramInbound,
  env: { ownerId: string; ownerUserId?: string; botUserId?: string; botUsername?: string },
  options: {
    chatEnabled?: TelegramChannelEnabled;
    featureEnabled?: (chatId: string, feature: string) => boolean;
  } = {},
): Promise<void> {
  const mentionRegex = buildTelegramMentionRegex(env.botUsername);
  const chatEnabled = options.chatEnabled ?? isTelegramChatEnabled;
  const featureEnabled = options.featureEnabled
    ?? ((chatId: string, feature: string) => isTelegramFeatureEnabled(chatId, feature));

  await processInboundMessage(messenger, inbound, {
    isReplyToBot: () => false,

    isAcknowledgment: () => false,

    sendAcknowledgmentReaction: async () => {
      // no-op — Telegram acknowledgment reactions are not implemented (matches Discord).
    },

    handleGroupMessage: async ({ inbound: m, text, hasMedia, audio }) => {
      const trimmed = text.trim();
      const mentionMatch = mentionRegex?.exec(trimmed) ?? null;
      // client.ts pre-computes "was this message addressed to the bot" (an
      // @username mention or a reply to one of the bot's own messages) into
      // mentionedIds, the same signal Discord's mentionedIds carries.
      const mentionedInline = !!env.botUserId
        && Array.isArray(m.mentionedIds)
        && m.mentionedIds.includes(env.botUserId);
      const isBang = trimmed.startsWith('!');
      const isAddressed = Boolean(mentionMatch) || mentionedInline || isBang;
      const requiresMention = telegramChatRequiresMention(m.chatId);

      if (requiresMention && !isAddressed) return;

      const query = mentionMatch ? trimmed.slice(mentionMatch[0].length).trim() : trimmed;

      if (!query && !hasMedia) return;

      await processGroupMessage({
        messenger,
        chatId: m.chatId,
        senderId: m.senderId,
        groupName: getTelegramChatName(m.chatId) ?? `Telegram ${m.chatId}`,
        ownerId: env.ownerId,
        ownerUserId: env.ownerUserId,
        query,
        isFeatureEnabled: featureEnabled,
        getResponse,
        messageId: m.messageId,
        replyTo: m.raw,
        audio,
      });
    },

    handleOwnerDM: async ({ inbound: m, text }) => {
      if (!env.ownerUserId || m.senderId !== env.ownerUserId) return;

      const response = await getResponse(
        text,
        {
          groupName: 'Telegram DM',
          groupJid: m.chatId,
          senderJid: m.senderId,
        },
        featureEnabled,
      );

      if (response) {
        await messenger.sendText(m.chatId, response, { replyTo: m.raw });
      }
    },

    captureForBridge,
  }, {
    ownerId: env.ownerId,
    isGroupEnabled: chatEnabled,
    // Introductions/events passive-detection channels are not part of the
    // Telegram core adapter (T2 scope) — reuse the same core pipeline with
    // both disabled rather than forking it.
    introductionsChatId: null,
    eventsChatId: null,
    handleIntroduction: async () => null,
    handleEventPassive: async () => null,
  });
}

/**
 * Process a normalized Telegram message event (built by client.ts's
 * mapTelegramMessageToPayload) through the shared core dispatch pipeline.
 */
export async function processTelegramEvent(
  messenger: PlatformMessenger,
  eventPayload: unknown,
  env: { ownerId: string; ownerUserId?: string; botUserId?: string; botUsername?: string },
): Promise<void> {
  const parsed = TelegramEventSchema.safeParse(eventPayload);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Invalid Telegram message payload');
    return;
  }

  const inbound = normalizeTelegramInbound(parsed.data);
  await processTelegramInbound(messenger, inbound, env);
}
