import {
  ATTACHMENT_READ_MAX_BYTES,
  type ReadableAttachment,
  type ReadableAttachmentKind,
} from '../../core/attachment-reading.js';
import { fetchBoundedBuffer } from '../../utils/bounded-fetch.js';
import { logger } from '../../middleware/logger.js';
import type { InboundMessage } from '../../core/inbound-message.js';

import type { DiscordMessageAttachments } from './attachment-classification.js';

/**
 * Discord collector for the platform-agnostic attachment reader
 * (src/core/attachment-reading.ts). WhatsApp has fed images to vision since
 * the beginning; Discord only threaded attachment refs, so the bot was blind
 * to dropped files. The collector runs strictly AFTER the engagement
 * decision — nothing here downloads for a message the bot will not answer.
 *
 * Direct attachments come off the inbound message; a replied-to message's
 * attachments are fetched lazily by the processor via
 * `DiscordMessenger.fetchMessageAttachments` (discord.js threads only the
 * reference id) and mapped here — the engaging message's own attachment
 * always wins, so the REST fetch never even happens when one exists.
 */

export type DiscordMediaRef = NonNullable<InboundMessage['media']>;
export type DiscordAudioRef = { url: string; contentType: string; ptt?: boolean };

// The discord CDN url can carry signed query params — log the host only.
function urlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function boundedCdnBytes(url: string): () => Promise<Buffer | null> {
  return () => fetchBoundedBuffer(url, {
    maxBytes: ATTACHMENT_READ_MAX_BYTES,
    onFailure: (failure) => {
      logger.warn({ host: urlHost(url), reason: failure.reason }, 'Discord attachment fetch failed');
    },
  });
}

function mediaKind(media: Pick<DiscordMediaRef, 'contentType' | 'kind'>): ReadableAttachmentKind {
  if (media.contentType === 'image/gif') return 'gif';
  if (media.kind === 'sticker') return 'sticker';
  if (media.contentType.startsWith('image/')) return 'image';
  if (media.contentType.startsWith('video/')) return 'video';
  return 'document';
}

function mediaAttachment(media: DiscordMediaRef | undefined): ReadableAttachment[] {
  if (!media) return [];
  const url = media.url;
  return [{
    kind: mediaKind(media),
    contentType: media.contentType,
    ...(media.fileName ? { fileName: media.fileName } : {}),
    bytes: url ? boundedCdnBytes(url) : async () => null,
  }];
}

function audioAttachment(audio: DiscordAudioRef | undefined): ReadableAttachment[] {
  if (!audio) return [];
  return [{
    kind: 'audio',
    contentType: audio.contentType,
    ...(audio.ptt === undefined ? {} : { ptt: audio.ptt }),
    bytes: boundedCdnBytes(audio.url),
  }];
}

/** Collect the engaging message's OWN readable attachments. */
export function collectDiscordDirectAttachments(
  m: Pick<InboundMessage, 'media' | 'audio'>,
): ReadableAttachment[] {
  return [...mediaAttachment(m.media), ...audioAttachment(m.audio)];
}

/**
 * Map a REST-fetched referenced message's classified attachments
 * (`DiscordMessenger.fetchMessageAttachments`) into readable attachments.
 */
export function collectDiscordReferencedAttachments(
  referenced: DiscordMessageAttachments,
): ReadableAttachment[] {
  return [...mediaAttachment(referenced.media), ...audioAttachment(referenced.audio)];
}
