import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { processInboundMessage } from '../../core/process-inbound-message.js';
import { processGroupMessage } from '../../core/process-group-message.js';
import { getResponse } from '../../core/response-router.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import { createMessageRef } from '../../core/message-ref.js';
import { isFeatureEnabled } from '../../core/groups-config.js';

import type { DiscordInbound } from './inbound.js';

export async function processDiscordEvent(_event: unknown): Promise<void> {
  logger.fatal({ platform: 'discord' }, 'Discord processor is not implemented yet');
  throw new Error('Discord processor is not implemented');
}

const DiscordDemoMessageSchema = z.object({
  chatId: z.string().min(1),
  senderId: z.string().min(1),
  text: z.string().default(''),
  isGroupChat: z.coerce.boolean().default(true),
  groupName: z.string().optional(),
  threadId: z.string().min(1).optional(),
});

export type DiscordDemoMessage = z.infer<typeof DiscordDemoMessageSchema>;

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
  await processInboundMessage(messenger, inbound, {
    isReplyToBot: () => false,

    isAcknowledgment: () => false,

    sendAcknowledgmentReaction: async () => {
      // no-op for demo
    },

    handleGroupMessage: async ({ inbound: m, text, hasMedia }) => {
      const trimmed = text.trim();
      const mentionMatch = /^@garbanzo\b[:\s]*/i.exec(trimmed);
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
        groupName: 'Discord (demo)',
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
          groupName: 'Discord DM (demo)',
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
