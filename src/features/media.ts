/**
 * Media understanding — process images, videos, GIFs, and stickers
 * via Claude Vision API.
 *
 * Extracts media from WhatsApp messages (direct or quoted), downloads
 * the binary content, and prepares it for Claude's vision endpoint.
 *
 * Supported: images, stickers (webp), GIFs, video (first frame via ffmpeg).
 */

import {
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../middleware/logger.js';

const execAsync = promisify(exec);

export interface MediaContent {
  type: 'image' | 'video' | 'sticker' | 'gif';
  data: Buffer;
  mimeType: string;
  caption?: string;
}

/** Image data formatted for Claude Vision API. */
export interface VisionImage {
  base64: string;
  mediaType: string;
  description?: string;
}

/**
 * Extract downloadable media from a WhatsApp message.
 * Handles both direct media messages and quoted/replied media.
 */
export async function extractMedia(msg: WAMessage): Promise<MediaContent | null> {
  try {
    const content = normalizeMessageContent(msg.message);
    if (!content) return null;

    const contentType = getContentType(content);
    if (!contentType) return null;

    // Direct image
    if (contentType === 'imageMessage' && content.imageMessage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      return {
        type: 'image',
        data: buffer as Buffer,
        mimeType: content.imageMessage.mimetype ?? 'image/jpeg',
        caption: content.imageMessage.caption ?? undefined,
      };
    }

    // Direct video (GIF = videoMessage with gifPlayback)
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

    // Direct sticker
    if (contentType === 'stickerMessage' && content.stickerMessage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      return {
        type: 'sticker',
        data: buffer as Buffer,
        mimeType: content.stickerMessage.mimetype ?? 'image/webp',
      };
    }

    // Quoted media (replying to a media message)
    return await extractQuotedMedia(content);
  } catch (err) {
    logger.error({ err }, 'Failed to extract media from message');
    return null;
  }
}

async function extractQuotedMedia(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: Record<string, any>,
): Promise<MediaContent | null> {
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

/**
 * Check if a message contains visual media (image, video, sticker, GIF).
 */
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

/**
 * Check if a message is a voice note (PTT audio).
 */
export function isVoiceMessage(msg: WAMessage): boolean {
  const content = normalizeMessageContent(msg.message);
  if (!content) return false;
  return getContentType(content) === 'audioMessage' && !!content.audioMessage?.ptt;
}

/**
 * Download voice message audio as a Buffer.
 */
export async function downloadVoiceAudio(msg: WAMessage): Promise<Buffer | null> {
  try {
    return await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
  } catch (err) {
    logger.error({ err }, 'Failed to download voice audio');
    return null;
  }
}

/**
 * Prepare media for Claude Vision API. Handles:
 * - Images/stickers/GIFs: send directly as base64
 * - Videos: extract first frame via ffmpeg, send as image
 *
 * Returns array of vision images (multiple frames for longer videos).
 */
export async function prepareForVision(media: MediaContent): Promise<VisionImage[]> {
  if (media.type === 'image' || media.type === 'sticker') {
    // Claude supports jpeg, png, gif, webp
    return [{
      base64: media.data.toString('base64'),
      mediaType: normalizeMediaType(media.mimeType),
      description: media.caption,
    }];
  }

  if (media.type === 'gif') {
    return [{
      base64: media.data.toString('base64'),
      mediaType: 'image/gif',
      description: media.caption,
    }];
  }

  if (media.type === 'video') {
    return await extractVideoFrames(media.data);
  }

  return [];
}

/**
 * Extract frames from video buffer using ffmpeg.
 * Short videos (<30s): 3 frames. Longer: 1 frame every 10s, max 10 frames.
 */
async function extractVideoFrames(videoBuffer: Buffer): Promise<VisionImage[]> {
  const tmpVideo = join(tmpdir(), `garbanzo-video-${Date.now()}.mp4`);
  const tmpFrame = join(tmpdir(), `garbanzo-frame-${Date.now()}-%03d.jpg`);

  try {
    await writeFile(tmpVideo, videoBuffer);

    // Get video duration
    const { stdout: durationOut } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${tmpVideo}"`,
    );
    const duration = parseFloat(durationOut.trim()) || 5;

    // Decide frame extraction strategy
    let filter: string;
    if (duration <= 30) {
      // Short: extract 3 evenly spaced frames
      const interval = Math.max(1, Math.floor(duration / 3));
      filter = `fps=1/${interval}`;
    } else {
      // Long: 1 frame every 10 seconds, max 10
      filter = 'fps=1/10';
    }

    await execAsync(
      `ffmpeg -y -i "${tmpVideo}" -vf "${filter}" -frames:v 10 -q:v 2 "${tmpFrame}" 2>/dev/null`,
    );

    // Read extracted frames
    const frames: VisionImage[] = [];
    for (let i = 1; i <= 10; i++) {
      const framePath = tmpFrame.replace('%03d', String(i).padStart(3, '0'));
      try {
        const { readFile } = await import('fs/promises');
        const frameData = await readFile(framePath);
        frames.push({
          base64: frameData.toString('base64'),
          mediaType: 'image/jpeg',
          description: `Video frame ${i}`,
        });
        await unlink(framePath).catch(() => {});
      } catch {
        break; // No more frames
      }
    }

    return frames.length > 0 ? frames : [];
  } catch (err) {
    logger.error({ err }, 'Failed to extract video frames');
    return [];
  } finally {
    await unlink(tmpVideo).catch(() => {});
  }
}

function normalizeMediaType(mime: string): string {
  // Claude accepts: image/jpeg, image/png, image/gif, image/webp
  if (mime.includes('webp')) return 'image/webp';
  if (mime.includes('png')) return 'image/png';
  if (mime.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}
