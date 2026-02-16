import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { processInboundMessage } from '../../core/process-inbound-message.js';
import { processGroupMessage } from '../../core/process-group-message.js';
import { getResponse } from '../../core/response-router.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import { createMessageRef } from '../../core/message-ref.js';
import type { SlackInbound } from './inbound.js';
import { isFeatureEnabled } from '../../core/groups-config.js';

/**
 * Slack processor skeleton.
 *
 * This will eventually normalize Slack events into `SlackInbound` and
 * pass them through the core inbound pipeline.
 */
export async function processSlackEvent(_event: unknown): Promise<void> {
  logger.fatal({ platform: 'slack' }, 'Slack processor is not implemented yet');
  throw new Error('Slack processor is not implemented');
}

const SlackDemoMessageSchema = z.object({
  chatId: z.string().min(1),
  senderId: z.string().min(1),
  text: z.string().default(''),
  isGroupChat: z.coerce.boolean().default(true),
  groupName: z.string().optional(),

  // demo-only; used to simulate Slack thread replies
  threadId: z.string().min(1).optional(),
});

export type SlackDemoMessage = z.infer<typeof SlackDemoMessageSchema>;

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
 *
 * This exists to validate core/platform wiring without pulling in Slack SDKs.
 */
export async function processSlackDemoInbound(
  messenger: PlatformMessenger,
  inbound: SlackInbound,
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

      // Keep behavior closer to WhatsApp: ignore unless explicitly invoked.
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
        groupName: 'Slack (demo)',
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
          groupName: 'Slack DM (demo)',
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
