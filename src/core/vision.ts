import { exec } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { logger } from '../middleware/logger.js';

const execAsync = promisify(exec);

export type VisionMediaType = 'image' | 'video' | 'sticker' | 'gif';

export interface VisionMedia {
  type: VisionMediaType;
  data: Buffer;
  mimeType: string;
  caption?: string;
}

/** Image payload formatted for vision-capable LLMs. */
export interface VisionImage {
  base64: string;
  mediaType: string;
  description?: string;
}

/**
 * Prepare media for vision-capable LLMs.
 *
 * - Images/stickers/GIFs: send directly as base64
 * - Videos: extract frames via ffmpeg, send as images
 */
export async function prepareForVision(media: VisionMedia): Promise<VisionImage[]> {
  if (media.type === 'image' || media.type === 'sticker') {
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
    return extractVideoFrames(media.data);
  }

  return [];
}

/**
 * Extract frames from a video buffer using ffmpeg.
 * Short videos (<30s): 3 frames. Longer: 1 frame every 10s, max 10 frames.
 */
async function extractVideoFrames(videoBuffer: Buffer): Promise<VisionImage[]> {
  const now = Date.now();
  const tmpVideo = join(tmpdir(), `garbanzo-video-${now}.mp4`);
  const tmpFrame = join(tmpdir(), `garbanzo-frame-${now}-%03d.jpg`);

  try {
    await writeFile(tmpVideo, videoBuffer);

    const { stdout: durationOut } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${tmpVideo}"`,
    );
    const duration = Number.parseFloat(durationOut.trim()) || 5;

    let filter: string;
    if (duration <= 30) {
      const interval = Math.max(1, Math.floor(duration / 3));
      filter = `fps=1/${interval}`;
    } else {
      filter = 'fps=1/10';
    }

    await execAsync(
      `ffmpeg -y -i "${tmpVideo}" -vf "${filter}" -frames:v 10 -q:v 2 "${tmpFrame}" 2>/dev/null`,
    );

    const frames: VisionImage[] = [];
    for (let i = 1; i <= 10; i++) {
      const framePath = tmpFrame.replace('%03d', String(i).padStart(3, '0'));
      try {
        const { readFile } = await import('node:fs/promises');
        const frameData = await readFile(framePath);
        frames.push({
          base64: frameData.toString('base64'),
          mediaType: 'image/jpeg',
          description: `Video frame ${i}`,
        });
        await unlink(framePath).catch(() => undefined);
      } catch {
        break;
      }
    }

    return frames.length > 0 ? frames : [];
  } catch (err) {
    logger.error({ err, tmpVideo }, 'Failed to extract video frames');
    return [];
  } finally {
    await unlink(tmpVideo).catch(() => undefined);
  }
}

function normalizeMediaType(mime: string): string {
  // Common LLMs accept: image/jpeg, image/png, image/gif, image/webp
  if (mime.includes('webp')) return 'image/webp';
  if (mime.includes('png')) return 'image/png';
  if (mime.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}
