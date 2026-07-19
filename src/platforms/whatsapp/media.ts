import {
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageContent,
} from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import type { VisionMedia } from '../../core/vision.js';
import type { InboundMessage } from '../../core/inbound-message.js';
import { MEDIA_FETCH_TIMEOUT_MS } from '../../utils/bounded-fetch.js';

type WhatsAppMedia = NonNullable<InboundMessage['media']>;

function classifyContent(content: WAMessageContent | undefined): WhatsAppMedia | undefined {
  if (!content) return undefined;
  const contentType = getContentType(content);
  if (contentType === 'imageMessage' && content.imageMessage) {
    return { contentType: content.imageMessage.mimetype ?? 'image/jpeg', kind: 'image' };
  }
  if (contentType === 'videoMessage' && content.videoMessage) {
    return { contentType: content.videoMessage.mimetype ?? 'video/mp4', kind: 'video' };
  }
  if (contentType === 'stickerMessage' && content.stickerMessage) {
    return { contentType: content.stickerMessage.mimetype ?? 'image/webp', kind: 'sticker' };
  }
  if (contentType === 'documentMessage' && content.documentMessage) {
    return {
      contentType: content.documentMessage.mimetype ?? 'application/octet-stream',
      fileName: content.documentMessage.fileName ?? undefined,
      kind: 'document',
    };
  }
  return undefined;
}

function quotedContent(content: WAMessageContent): WAMessageContent | undefined {
  const contextInfo = content.extendedTextMessage?.contextInfo
    ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo
    ?? content.documentMessage?.contextInfo;
  return normalizeMessageContent(contextInfo?.quotedMessage);
}

export function classifyWhatsAppMedia(msg: WAMessage): WhatsAppMedia | undefined {
  const content = normalizeMessageContent(msg.message);
  return classifyContent(content) ?? (content ? classifyContent(quotedContent(content)) : undefined);
}

export async function downloadWhatsAppMedia(msg: WAMessage, maxBytes: number): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
  try {
    const content = normalizeMessageContent(msg.message);
    if (!content) return null;
    let downloadMessage = msg;
    if (!classifyContent(content)) {
      const contextInfo = content.extendedTextMessage?.contextInfo
        ?? content.imageMessage?.contextInfo
        ?? content.videoMessage?.contextInfo
        ?? content.documentMessage?.contextInfo;
      if (!contextInfo?.quotedMessage || !classifyContent(normalizeMessageContent(contextInfo.quotedMessage))) return null;
      downloadMessage = {
        key: { id: contextInfo.stanzaId, remoteJid: msg.key.remoteJid },
        message: contextInfo.quotedMessage,
      } as WAMessage;
    }

    const stream = await downloadMediaMessage(downloadMessage, 'stream', {
      options: { signal: controller.signal },
    });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        return null;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    logger.warn({ err, msgId: msg.key.id }, 'Failed to download WhatsApp bridge media');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

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

    return extractQuotedMedia(content, msg.key.remoteJid ?? undefined);
  } catch (err) {
    logger.error({ err, msgId: msg.key.id, remoteJid: msg.key.remoteJid }, 'Failed to extract media from message');
    return null;
  }
}

async function extractQuotedMedia(content: WAMessageContent, remoteJid: string | undefined): Promise<VisionMedia | null> {
  const contextInfo =
    content.extendedTextMessage?.contextInfo
    ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo;

  if (!contextInfo?.quotedMessage) return null;

  const quoted = normalizeMessageContent(contextInfo.quotedMessage);
  if (!quoted) return null;

  const quotedType = getContentType(quoted);
  const fakeMsg = {
    key: {
      id: contextInfo.stanzaId,
      remoteJid,
    },
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
  if (ct === 'imageMessage' || ct === 'videoMessage' || ct === 'stickerMessage' || ct === 'documentMessage') return true;

  // Check quoted message for media too
  const ci = content.extendedTextMessage?.contextInfo;
  if (ci?.quotedMessage) {
    const qt = getContentType(normalizeMessageContent(ci.quotedMessage));
    if (qt === 'imageMessage' || qt === 'videoMessage' || qt === 'stickerMessage' || qt === 'documentMessage') return true;
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
