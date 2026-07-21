import {
  getContentType,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageContent,
} from '@whiskeysockets/baileys';

import {
  ATTACHMENT_READ_MAX_BYTES,
  pickAttachments,
  type ReadableAttachment,
} from '../../core/attachment-reading.js';
import { downloadBoundedWhatsAppMedia } from './media.js';

/**
 * WhatsApp collector for the platform-agnostic attachment reader
 * (src/core/attachment-reading.ts). Runs strictly AFTER the engagement
 * decision in group-handler; classification here is metadata-only and all
 * byte downloads are lazy and bounded.
 *
 * Direct PTT voice notes are deliberately NOT collected: the processor
 * already transcribed them inline (the message text IS the transcript), so
 * collecting them again would duplicate the transcript. Quoted audio — PTT
 * or not — and direct non-PTT audio are collected and transcribed here.
 */

function attachmentsFromContent(
  content: WAMessageContent | undefined,
  download: () => Promise<Buffer | null>,
  options: { includePttAudio: boolean },
): ReadableAttachment[] {
  if (!content) return [];
  const contentType = getContentType(content);

  if (contentType === 'imageMessage' && content.imageMessage) {
    return [{
      kind: 'image',
      contentType: content.imageMessage.mimetype ?? 'image/jpeg',
      caption: content.imageMessage.caption ?? undefined,
      bytes: download,
    }];
  }

  if (contentType === 'videoMessage' && content.videoMessage) {
    return [{
      kind: content.videoMessage.gifPlayback ? 'gif' : 'video',
      contentType: content.videoMessage.mimetype ?? 'video/mp4',
      caption: content.videoMessage.caption ?? undefined,
      bytes: download,
    }];
  }

  if (contentType === 'stickerMessage' && content.stickerMessage) {
    return [{
      kind: 'sticker',
      contentType: content.stickerMessage.mimetype ?? 'image/webp',
      bytes: download,
    }];
  }

  if (contentType === 'audioMessage' && content.audioMessage) {
    const ptt = !!content.audioMessage.ptt;
    if (ptt && !options.includePttAudio) return [];
    return [{
      kind: 'audio',
      contentType: content.audioMessage.mimetype ?? 'audio/ogg',
      ptt,
      bytes: download,
    }];
  }

  if (contentType === 'documentMessage' && content.documentMessage) {
    return [{
      kind: 'document',
      contentType: content.documentMessage.mimetype ?? 'application/octet-stream',
      fileName: content.documentMessage.fileName ?? undefined,
      bytes: download,
    }];
  }

  return [];
}

function quotedAttachments(msg: WAMessage, content: WAMessageContent): ReadableAttachment[] {
  const contextInfo = content.extendedTextMessage?.contextInfo
    ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo
    ?? content.documentMessage?.contextInfo
    ?? content.audioMessage?.contextInfo;
  if (!contextInfo?.quotedMessage) return [];

  const quoted = normalizeMessageContent(contextInfo.quotedMessage);
  // Same synthesized-message pattern as extractQuotedMedia/downloadWhatsAppMedia:
  // Baileys can download quoted media given the quoted content + stanza key.
  const quotedMsg = {
    key: { id: contextInfo.stanzaId, remoteJid: msg.key.remoteJid },
    message: contextInfo.quotedMessage,
  } as WAMessage;

  return attachmentsFromContent(
    quoted,
    () => downloadBoundedWhatsAppMedia(quotedMsg, ATTACHMENT_READ_MAX_BYTES),
    { includePttAudio: true },
  );
}

/**
 * Collect the engaged message's readable attachments — its own first, the
 * quoted (replied-to) message's as fallback.
 */
export function collectWhatsAppAttachments(msg: WAMessage): ReadableAttachment[] {
  const content = normalizeMessageContent(msg.message);
  if (!content) return [];

  const direct = attachmentsFromContent(
    content,
    () => downloadBoundedWhatsAppMedia(msg, ATTACHMENT_READ_MAX_BYTES),
    { includePttAudio: false },
  );

  return pickAttachments(direct, quotedAttachments(msg, content));
}
