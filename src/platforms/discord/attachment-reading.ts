import { prepareForVision, type VisionImage, type VisionMediaType } from '../../core/vision.js';
import { fetchBoundedBuffer } from '../../utils/bounded-fetch.js';
import { transcribeAudio } from '../../features/voice.js';
import { logger } from '../../middleware/logger.js';

/**
 * Attachment reading for the Discord reply path. WhatsApp has fed images to
 * vision since the beginning (group-handler → extractMedia → prepareForVision);
 * Discord only threaded attachment refs, so the bot was blind to dropped
 * files. These helpers run strictly AFTER the engagement decision — nothing
 * here downloads for a message the bot will not answer.
 */

/** Independent of the bridge media cap: attachment reading is a reply feature. */
export const ATTACHMENT_READ_MAX_BYTES = 8 * 1024 * 1024;

import type { InboundMessage } from '../../core/inbound-message.js';

export type DiscordMediaRef = NonNullable<InboundMessage['media']>;

// The discord CDN url can carry signed query params — log the host only.
function urlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function visionTypeFor(media: DiscordMediaRef): VisionMediaType | null {
  if (media.contentType === 'image/gif') return 'gif';
  if (media.kind === 'sticker') return 'sticker';
  if (media.contentType.startsWith('image/')) return 'image';
  if (media.contentType.startsWith('video/')) return 'video';
  return null;
}

/**
 * Download an engaged message's image/gif/video attachment (bounded) and
 * prepare it for a vision-capable model. Returns undefined on any failure or
 * for non-visual kinds — the caller falls back to a context line.
 */
export async function prepareDiscordVision(
  media: DiscordMediaRef,
  caption: string,
): Promise<VisionImage[] | undefined> {
  const type = visionTypeFor(media);
  if (!type || !media.url) return undefined;
  const url = media.url;

  const data = await fetchBoundedBuffer(url, {
    maxBytes: ATTACHMENT_READ_MAX_BYTES,
    onFailure: (failure) => {
      logger.warn({ host: urlHost(url), reason: failure.reason }, 'Discord attachment fetch failed');
    },
  });
  if (!data) return undefined;

  try {
    const images = await prepareForVision({
      type,
      data,
      mimeType: media.contentType,
      caption: caption || undefined,
    });
    return images.length > 0 ? images : undefined;
  } catch (err) {
    logger.warn({ err, host: urlHost(url) }, 'Discord attachment vision preparation failed');
    return undefined;
  }
}

/**
 * Context line for attachments the bot cannot ingest (documents, failed
 * vision) so the model can refer to them honestly instead of being blind.
 */
export function attachmentContextLine(media: DiscordMediaRef): string {
  return `[attachment: ${media.fileName ?? 'file'} (${media.contentType})]`;
}

/**
 * Transcribe an engaged message's audio attachment. Gated on an explicit
 * WHISPER_URL (matching the bridge and song-ideas convention) so deployments
 * without a transcription server never pay a doomed fetch per voice message.
 * Any failure returns null and the reply proceeds without a transcript.
 */
export async function transcribeDiscordAttachment(
  audio: { url: string; contentType: string },
): Promise<string | null> {
  if (!process.env.WHISPER_URL) return null;

  const data = await fetchBoundedBuffer(audio.url, {
    maxBytes: ATTACHMENT_READ_MAX_BYTES,
    onFailure: (failure) => {
      logger.warn({ host: urlHost(audio.url), reason: failure.reason }, 'Discord audio attachment fetch failed');
    },
  });
  if (!data) return null;

  try {
    const transcript = await transcribeAudio(data, audio.contentType);
    const clean = transcript?.trim();
    return clean ? clean : null;
  } catch (err) {
    logger.warn({ err, host: urlHost(audio.url) }, 'Discord audio attachment transcription failed');
    return null;
  }
}
