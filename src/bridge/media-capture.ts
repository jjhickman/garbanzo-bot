import type { InboundMessage } from '../core/inbound-message.js';
import { logger } from '../middleware/logger.js';
import { fetchBoundedBuffer } from '../utils/bounded-fetch.js';
import {
  BRIDGE_MEDIA_MIME_TYPES,
  type BridgeMedia,
} from './envelope.js';

function isAllowedMimeType(value: string): value is BridgeMedia['mimetype'] {
  return (BRIDGE_MEDIA_MIME_TYPES as readonly string[]).includes(value);
}

function urlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export async function fetchBridgeMedia(url: string, maxBytes: number): Promise<Buffer | null> {
  return fetchBoundedBuffer(url, {
    maxBytes,
    onFailure: (failure) => {
      if (failure.reason === 'status') {
        logger.warn({ host: urlHost(url), status: failure.status }, 'Bridge capture: media fetch failed');
      } else if (failure.reason === 'size') {
        logger.warn(
          { host: urlHost(url), ...(failure.contentLength ? { contentLength: failure.contentLength } : {}) },
          'Bridge capture: media exceeds size cap',
        );
      } else {
        logger.warn({ host: urlHost(url), err: failure.error }, 'Bridge capture: media fetch/read failed');
      }
    },
  });
}

function defaultFileName(kind: BridgeMedia['kind'], mimetype: BridgeMedia['mimetype']): string {
  const extension = mimetype === 'image/jpeg'
    ? 'jpg'
    : mimetype === 'audio/mpeg'
      ? 'mp3'
      : mimetype === 'application/pdf'
        ? 'pdf'
        : mimetype.split('/')[1] ?? 'bin';
  return `${kind}.${extension}`;
}

async function mediaBuffer(inbound: InboundMessage, maxBytes: number): Promise<Buffer | null> {
  if (inbound.audio) {
    if (inbound.audio.buffer) return inbound.audio.buffer;
    return /^https?:\/\//i.test(inbound.audio.url)
      ? fetchBridgeMedia(inbound.audio.url, maxBytes)
      : null;
  }
  if (!inbound.media) return null;
  if (inbound.media.buffer) return inbound.media.buffer;
  if (inbound.media.url && /^https?:\/\//i.test(inbound.media.url)) {
    return fetchBridgeMedia(inbound.media.url, maxBytes);
  }
  if (inbound.platform === 'whatsapp' && 'waMessage' in inbound) {
    const { downloadWhatsAppMedia } = await import('../platforms/whatsapp/media.js');
    return downloadWhatsAppMedia(inbound.waMessage as never, maxBytes);
  }
  return null;
}

export async function captureInboundMedia(
  inbound: InboundMessage,
  maxBytes: number,
  prefetchedAudio?: Buffer | null,
): Promise<BridgeMedia | null> {
  const source = inbound.audio
    ? {
      contentType: inbound.audio.contentType,
      kind: 'audio' as const,
      ptt: inbound.audio.ptt,
      fileName: undefined,
    }
    : inbound.media;
  if (!source || !isAllowedMimeType(source.contentType)) return null;

  const buffer = inbound.audio && prefetchedAudio !== undefined
    ? prefetchedAudio
    : await mediaBuffer(inbound, maxBytes);
  if (!buffer || buffer.byteLength > maxBytes) return null;

  return {
    data: buffer.toString('base64'),
    mimetype: source.contentType,
    fileName: source.fileName ?? defaultFileName(source.kind, source.contentType),
    kind: source.kind,
    ...(source.ptt === undefined ? {} : { ptt: source.ptt }),
  };
}
