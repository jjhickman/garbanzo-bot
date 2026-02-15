import {
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageContent,
} from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import type { VisionMedia } from '../../core/vision.js';

/**
 * Extract downloadable visual media from a WhatsApp message.
 * Handles both direct media messages and quoted/replied media.
 */
export async function extractMedia(msg: WAMessage): Promise<VisionMedia | null> {
  try {
    const content = normalizeMessageContent(msg.message);
    if (!content) return null;

    const contentType = getContentType(content);
    if (!contentType) return null;

    if (contentType === 'imageMessage' && content.imageMessage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      return {
        type: 'image',
        data: buffer as Buffer,
        mimeType: content.imageMessage.mimetype ?? 'image/jpeg',
        caption: content.imageMessage.caption ?? undefined,
      };
    }

    if (contentType === 'videoMessage' && content.videoMessage) {
      const isGif = !!content.videoMessage.gifPlayback;
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      return {
        type: isGif ? 'gif' : 'video',
        data: buffer as Buffer,
        mimeType: content.videoMessage.mimetype ?? 'video/mp4',
        caption: content.videoMessage.caption ?? undefined,
      };
    }

    if (contentType === 'stickerMessage' && content.stickerMessage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      return {
        type: 'sticker',
        data: buffer as Buffer,
        mimeType: content.stickerMessage.mimetype ?? 'image/webp',
      };
    }

    return extractQuotedMedia(content);
  } catch (err) {
    logger.error({ err, msgId: msg.key.id, remoteJid: msg.key.remoteJid }, 'Failed to extract media from message');
    return null;
  }
}

async function extractQuotedMedia(content: WAMessageContent): Promise<VisionMedia | null> {
  const contextInfo =
    content.extendedTextMessage?.contextInfo
    ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo;

  if (!contextInfo?.quotedMessage) return null;

  const quoted = normalizeMessageContent(contextInfo.quotedMessage);
  if (!quoted) return null;

  const quotedType = getContentType(quoted);
  const fakeMsg = {
    key: { id: contextInfo.stanzaId },
    message: contextInfo.quotedMessage,
  } as WAMessage;

  if (quotedType === 'imageMessage' && quoted.imageMessage) {
    const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {});
    return {
      type: 'image',
      data: buffer as Buffer,
      mimeType: quoted.imageMessage.mimetype ?? 'image/jpeg',
      caption: quoted.imageMessage.caption ?? undefined,
    };
  }

  if (quotedType === 'videoMessage' && quoted.videoMessage) {
    const isGif = !!quoted.videoMessage.gifPlayback;
    const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {});
    return {
      type: isGif ? 'gif' : 'video',
      data: buffer as Buffer,
      mimeType: quoted.videoMessage.mimetype ?? 'video/mp4',
      caption: quoted.videoMessage.caption ?? undefined,
    };
  }

  if (quotedType === 'stickerMessage' && quoted.stickerMessage) {
    const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {});
    return {
      type: 'sticker',
      data: buffer as Buffer,
      mimeType: quoted.stickerMessage.mimetype ?? 'image/webp',
    };
  }

  return null;
}

/** Check if a message contains visual media (image, video, sticker, GIF). */
export function hasVisualMedia(msg: WAMessage): boolean {
  const content = normalizeMessageContent(msg.message);
  if (!content) return false;
  const ct = getContentType(content);
  if (ct === 'imageMessage' || ct === 'videoMessage' || ct === 'stickerMessage') return true;

  // Check quoted message for media too
  const ci = content.extendedTextMessage?.contextInfo;
  if (ci?.quotedMessage) {
    const qt = getContentType(normalizeMessageContent(ci.quotedMessage));
    if (qt === 'imageMessage' || qt === 'videoMessage' || qt === 'stickerMessage') return true;
  }

  return false;
}

/** Check if a message is a voice note (PTT audio). */
export function isVoiceMessage(msg: WAMessage): boolean {
  const content = normalizeMessageContent(msg.message);
  if (!content) return false;
  return getContentType(content) === 'audioMessage' && !!content.audioMessage?.ptt;
}

/** Download voice message audio as a Buffer. */
export async function downloadVoiceAudio(msg: WAMessage): Promise<Buffer | null> {
  try {
    return await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
  } catch (err) {
    logger.error({ err, msgId: msg.key.id, remoteJid: msg.key.remoteJid }, 'Failed to download voice audio');
    return null;
  }
}
