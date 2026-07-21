import type { WASocket, WAMessage, WAMessageContent } from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { requiresMention, getGroupName, isFeatureEnabled } from '../../core/groups-config.js';
import { isMentioned, stripMention } from './mentions.js';
import type { VisionImage } from '../../core/vision.js';
import { readAttachments } from '../../core/attachment-reading.js';
import { collectWhatsAppAttachments } from './attachment-reading.js';
import {
  extractWhatsAppMentionedJids as extractMentionedJids,
  extractWhatsAppQuotedText as extractQuotedText,
} from './inbound.js';
import { processGroupMessage } from '../../core/process-group-message.js';
import { createWhatsAppInboundMessageRef } from './message-ref.js';
import { getResponse } from '../../core/response-router.js';
import { createWhatsAppAdapter } from './adapter.js';

/**
 * Handle a group message that has already passed preprocessing
 * (sanitization, moderation, context recording, intro/events passive handlers).
 *
 * Platform-specific responsibilities kept here:
 * - mention detection / mention stripping
 * - attachment collection (direct + quoted) for the shared reading pipeline
 *
 * Core routing + response generation lives in `processGroupMessage`;
 * vision preparation and transcription live in `core/attachment-reading`.
 */
export async function handleGroupMessage(
  sock: WASocket,
  msg: WAMessage,
  remoteJid: string,
  senderJid: string,
  text: string,
  content: WAMessageContent | undefined,
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

  // Attachment reading (engagement already decided above): the message's own
  // media/audio, or the quoted message's when it has none. Bang commands are
  // skipped entirely — feature handlers own their raw queries.
  let visionImages: VisionImage[] | undefined;
  let enrichedQuery = query;
  if (!isBangCommand) {
    const attachments = collectWhatsAppAttachments(msg);
    if (attachments.length > 0) {
      const read = await readAttachments(attachments, query);
      visionImages = read.visionImages;
      enrichedQuery = read.enrichedQuery;
      if (visionImages) {
        logger.info({ imageCount: visionImages.length }, 'Media prepared for vision');
      }
    }
  }

  const messenger = createWhatsAppAdapter(sock);
  // Config schema requires OWNER_JID for the WhatsApp platform; this narrows
  // the conditional type at WhatsApp-only call sites.
  const ownerJid = config.OWNER_JID;
  if (!ownerJid) throw new Error('OWNER_JID is required for WhatsApp group handling');

  await processGroupMessage({
    messenger,
    chatId: remoteJid,
    senderId: senderJid,
    groupName,
    ownerId: ownerJid,
    query: enrichedQuery,
    isFeatureEnabled,
    getResponse,
    quotedText: extractQuotedText(content),
    messageId: msg.key.id ?? undefined,
    replyTo: createWhatsAppInboundMessageRef(remoteJid, msg),
    visionImages,
  });
}
