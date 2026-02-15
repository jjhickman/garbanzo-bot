import type { WASocket, WAMessage, WAMessageContent } from '@whiskeysockets/baileys';

import { logger } from '../middleware/logger.js';
import { requiresMention, isMentioned, stripMention, getGroupName } from './groups.js';
import { extractMedia, prepareForVision, type VisionImage } from '../features/media.js';
import { extractMentionedJids, extractQuotedText } from './handlers.js';
import { processGroupMessage } from '../core/process-group-message.js';
import { createWhatsAppAdapter } from '../platforms/whatsapp/adapter.js';

/**
 * Handle a group message that has already passed preprocessing
 * (sanitization, moderation, context recording, intro/events passive handlers).
 *
 * Platform-specific responsibilities kept here:
 * - mention detection / mention stripping
 * - media extraction and conversion to vision-ready payloads
 *
 * Core routing + response generation lives in `processGroupMessage`.
 */
export async function handleGroupMessage(
  sock: WASocket,
  msg: WAMessage,
  remoteJid: string,
  senderJid: string,
  text: string,
  content: WAMessageContent | undefined,
  hasMedia: boolean,
): Promise<void> {
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

  // Bang commands (!command) bypass the mention requirement — users expect them to just work
  const isBangCommand = /^\s*!/.test(text);
  if (requiresMention(remoteJid) && !isBangCommand && !isMentioned(text, mentionedJids, botJid, botLid)) return;

  const query = stripMention(text, botJid, botLid);
  const groupName = getGroupName(remoteJid);

  logger.info({ group: groupName, sender: senderJid, query }, 'Group mention');

  // Media understanding (images, videos, stickers, GIFs)
  let visionImages: VisionImage[] | undefined;
  if (hasMedia) {
    const media = await extractMedia(msg);
    if (media) {
      const images = await prepareForVision(media);
      if (images.length > 0) {
        visionImages = images;
        logger.info({ type: media.type, imageCount: images.length }, 'Media prepared for vision');
      }
    }
  }

  const messenger = createWhatsAppAdapter(sock);

  await processGroupMessage({
    messenger,
    chatId: remoteJid,
    senderId: senderJid,
    groupName,
    query,
    quotedText: extractQuotedText(content),
    messageId: msg.key.id ?? undefined,
    replyTo: msg,
    visionImages,
  });
}
