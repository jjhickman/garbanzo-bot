import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { processInboundMessage } from '../../core/process-inbound-message.js';
import { processGroupMessage } from '../../core/process-group-message.js';
import { getResponse } from '../../core/response-router.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import { createMessageRef } from '../../core/message-ref.js';
import { isFeatureEnabled } from '../../core/groups-config.js';

import type { DiscordInbound } from './inbound.js';

const DiscordAuthorSchema = z.object({
  id: z.string(),
  bot: z.boolean().optional(),
});

const DiscordMentionSchema = z.object({
  id: z.string(),
});

const DiscordMessageCreateSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  content: z.string().default(''),
  author: DiscordAuthorSchema,
  timestamp: z.string(),
  mentions: z.array(DiscordMentionSchema).optional(),
  referenced_message: z.object({
    id: z.string().optional(),
    content: z.string().optional(),
  }).nullable().optional(),
  attachments: z.array(z.unknown()).optional(),
});

type DiscordMessageCreate = z.infer<typeof DiscordMessageCreateSchema>;

const DiscordDemoMessageSchema = z.object({
  chatId: z.string().min(1),
  senderId: z.string().min(1),
  text: z.string().default(''),
  isGroupChat: z.coerce.boolean().default(true),
  groupName: z.string().optional(),
  threadId: z.string().min(1).optional(),
});

export type DiscordDemoMessage = z.infer<typeof DiscordDemoMessageSchema>;

function parseDiscordTimestamp(ts: string): number {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return Date.now();
  return parsed;
}

function normalizeDiscordInboundFromMessage(event: DiscordMessageCreate): DiscordInbound {
  return {
    platform: 'discord',
    chatId: event.channel_id,
    senderId: event.author.id,
    messageId: event.id,
    fromSelf: false,
    isStatusBroadcast: false,
    isGroupChat: Boolean(event.guild_id),
    timestampMs: parseDiscordTimestamp(event.timestamp),
    text: event.content,
    quotedText: event.referenced_message?.content,
    mentionedIds: event.mentions?.map((mention) => mention.id),
    hasVisualMedia: (event.attachments?.length ?? 0) > 0,
    raw: createMessageRef({
      platform: 'discord',
      chatId: event.channel_id,
      id: event.id,
      ref: {
        kind: 'discord-inbound',
        channelId: event.channel_id,
        messageId: event.id,
        threadId: null,
      },
    }),
  };
}

function buildDiscordMentionRegex(botUserId: string | undefined): RegExp {
  if (botUserId && botUserId.trim().length > 0) {
    const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^<@!?${escaped}>\\b[:\\s]*`, 'i');
  }

  return /^<@!?\d+>\b[:\s]*/i;
}

async function processDiscordInbound(
  messenger: PlatformMessenger,
  inbound: DiscordInbound,
  env: { ownerId: string; botUserId?: string },
): Promise<void> {
  const mentionRegex = buildDiscordMentionRegex(env.botUserId);

  await processInboundMessage(messenger, inbound, {
    isReplyToBot: () => false,

    isAcknowledgment: () => false,

    sendAcknowledgmentReaction: async () => {
      // no-op
    },

    handleGroupMessage: async ({ inbound: m, text, hasMedia }) => {
      const trimmed = text.trim();
      const mentionMatch = mentionRegex.exec(trimmed) ?? /^@garbanzo\b[:\s]*/i.exec(trimmed);
      const isBang = trimmed.startsWith('!');

      if (!mentionMatch && !isBang) return;

      let query = trimmed;
      if (isBang) {
        query = trimmed;
      } else if (mentionMatch) {
        query = trimmed.slice(mentionMatch[0].length).trim();
      }

      if (!query && !hasMedia) return;

      await processGroupMessage({
        messenger,
        chatId: m.chatId,
        senderId: m.senderId,
        groupName: `Discord ${m.chatId}`,
        ownerId: env.ownerId,
        query,
        isFeatureEnabled,
        getResponse,
        messageId: m.messageId,
        replyTo: m.raw,
      });
    },

    handleOwnerDM: async ({ inbound: m, text }) => {
      const response = await getResponse(
        text,
        {
          groupName: 'Discord DM',
          groupJid: m.chatId,
          senderJid: m.senderId,
        },
        isFeatureEnabled,
      );

      if (response) {
        await messenger.sendText(m.chatId, response, { replyTo: m.raw });
      }
    },
  }, {
    ownerId: env.ownerId,
    isGroupEnabled: () => true,
    introductionsChatId: null,
    eventsChatId: null,
    handleIntroduction: async () => null,
    handleEventPassive: async () => null,
  });
}

/**
 * Process a production Discord MESSAGE_CREATE event.
 */
export async function processDiscordEvent(
  messenger: PlatformMessenger,
  eventPayload: unknown,
  env: { ownerId: string; botUserId?: string },
): Promise<void> {
  const parsed = DiscordMessageCreateSchema.safeParse(eventPayload);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Invalid Discord message payload');
    return;
  }

  const event = parsed.data;
  if (event.author.bot) return;

  const inbound = normalizeDiscordInboundFromMessage(event);
  await processDiscordInbound(messenger, inbound, env);
}

export function normalizeDiscordDemoInbound(message: DiscordDemoMessage): DiscordInbound {
  const messageId = `discord-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return {
    platform: 'discord',
    chatId: message.chatId,
    senderId: message.senderId,
    messageId,
    fromSelf: false,
    isStatusBroadcast: false,
    isGroupChat: message.isGroupChat,
    timestampMs: Date.now(),
    text: message.text,
    hasVisualMedia: false,
    raw: createMessageRef({
      platform: 'discord',
      chatId: message.chatId,
      id: messageId,
      ref: {
        kind: 'discord-demo-inbound',
        threadId: message.threadId ?? null,
      },
    }),
  };
}

export function parseDiscordDemoMessage(input: unknown): DiscordDemoMessage {
  return DiscordDemoMessageSchema.parse(input);
}

export async function processDiscordDemoInbound(
  messenger: PlatformMessenger,
  inbound: DiscordInbound,
  env: {
    ownerId: string;
  },
): Promise<void> {
  await processDiscordInbound(messenger, inbound, env);
}
