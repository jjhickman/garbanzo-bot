import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { processInboundMessage } from '../../core/process-inbound-message.js';
import { processGroupMessage } from '../../core/process-group-message.js';
import { getResponse } from '../../core/response-router.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import { createMessageRef } from '../../core/message-ref.js';
import type { SlackInbound } from './inbound.js';
import { isFeatureEnabled } from '../../core/groups-config.js';

const SlackEventSchema = z.object({
  type: z.string().optional(),
  user: z.string().optional(),
  text: z.string().optional(),
  channel: z.string().optional(),
  channel_type: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
});

const SlackEventEnvelopeSchema = z.object({
  type: z.string(),
  event: SlackEventSchema.optional(),
});

type SlackEvent = z.infer<typeof SlackEventSchema>;

const SlackDemoMessageSchema = z.object({
  chatId: z.string().min(1).max(80),
  senderId: z.string().min(1).max(80),
  text: z.string().max(1500).default(''),
  isGroupChat: z.coerce.boolean().default(true),
  groupName: z.string().max(120).optional(),
  threadId: z.string().min(1).max(80).optional(),
});

export type SlackDemoMessage = z.infer<typeof SlackDemoMessageSchema>;

function parseSlackTimestamp(ts: string | undefined): number {
  if (!ts) return Date.now();
  const numeric = Number.parseFloat(ts);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now();
  return Math.floor(numeric * 1000);
}

function normalizeSlackInboundFromEvent(event: SlackEvent): SlackInbound | null {
  if (!event.channel || !event.user) return null;

  const ts = event.ts ?? `${Date.now() / 1000}`;
  const threadId = event.thread_ts ?? null;

  return {
    platform: 'slack',
    chatId: event.channel,
    senderId: event.user,
    messageId: ts,
    fromSelf: false,
    isStatusBroadcast: false,
    isGroupChat: event.channel_type !== 'im',
    timestampMs: parseSlackTimestamp(event.ts),
    text: event.text ?? '',
    hasVisualMedia: false,
    raw: createMessageRef({
      platform: 'slack',
      chatId: event.channel,
      id: ts,
      ref: {
        kind: 'slack-inbound',
        ts,
        channel: event.channel,
        threadId,
      },
    }),
  };
}

function buildMentionRegex(botUserId: string | undefined): RegExp {
  if (botUserId && botUserId.trim().length > 0) {
    const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^<@${escaped}>\\b[:\\s]*`, 'i');
  }

  return /^<@[^>]+>\b[:\s]*/i;
}

async function processSlackInbound(
  messenger: PlatformMessenger,
  inbound: SlackInbound,
  env: { ownerId: string; botUserId?: string },
): Promise<void> {
  const mentionRegex = buildMentionRegex(env.botUserId);

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
        groupName: `Slack ${m.chatId}`,
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
          groupName: 'Slack DM',
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
 * Process a production Slack Events API payload.
 */
export async function processSlackEvent(
  messenger: PlatformMessenger,
  envelope: unknown,
  env: { ownerId: string; botUserId?: string },
): Promise<void> {
  const parsed = SlackEventEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Invalid Slack event payload');
    return;
  }

  const event = parsed.data.event;
  if (!event) return;

  if (event.bot_id || event.subtype === 'bot_message') return;

  const inbound = normalizeSlackInboundFromEvent(event);
  if (!inbound) return;

  await processSlackInbound(messenger, inbound, env);
}

export function normalizeSlackDemoInbound(message: SlackDemoMessage): SlackInbound {
  const messageId = `slack-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    platform: 'slack',
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
      platform: 'slack',
      chatId: message.chatId,
      id: messageId,
      ref: {
        kind: 'slack-demo-inbound',
        threadId: message.threadId ?? null,
      },
    }),
  };
}

export function parseSlackDemoMessage(input: unknown): SlackDemoMessage {
  return SlackDemoMessageSchema.parse(input);
}

/**
 * Slack "demo mode" processor.
 */
export async function processSlackDemoInbound(
  messenger: PlatformMessenger,
  inbound: SlackInbound,
  env: {
    ownerId: string;
  },
): Promise<void> {
  await processSlackInbound(messenger, inbound, env);
}
