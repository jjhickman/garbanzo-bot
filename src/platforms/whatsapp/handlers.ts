import type { WASocket, WAMessage } from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import { isGroupEnabled, getGroupName, getEnabledGroupJidByName } from '../../bot/groups.js';
import { buildWelcomeMessage } from '../../features/welcome.js';
import { recordBotResponse } from '../../middleware/stats.js';
import { setRetryHandler, type RetryEntry } from '../../middleware/retry.js';
import { getResponse } from '../../bot/response-router.js';

import { processWhatsAppRawMessage } from './processor.js';

/**
 * Register WhatsApp socket event handlers.
 */
export function registerWhatsAppHandlers(sock: WASocket): void {
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

  const introductionsChatId = getEnabledGroupJidByName('Introductions');

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        // Process all message types for the Introductions group (catch-up path),
        // but only real-time ('notify') messages for everything else.
        const isIntroGroup = !!introductionsChatId && msg.key.remoteJid === introductionsChatId;
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

async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  // WhatsApp-specific preprocessing + core pipeline
  await processWhatsAppRawMessage(sock, msg);
}
