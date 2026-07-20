import {
  ATTACHMENT_READ_MAX_BYTES,
  pickAttachments,
  type ReadableAttachment,
} from '../../core/attachment-reading.js';
import type { InboundMessage } from '../../core/inbound-message.js';
import { downloadTelegramFile } from './telegram-voice.js';

/**
 * Telegram collector for the platform-agnostic attachment reader
 * (src/core/attachment-reading.ts).
 *
 * CREDENTIAL RULE: attachments are addressed by the safe `telegram-file:`
 * ref convention (see telegram-voice.ts) — bytes are resolved lazily via
 * downloadTelegramFile, strictly after engagement, and the token-bearing
 * URL never leaves that module.
 *
 * Direct voice notes are deliberately NOT collected: the processor's
 * resolveVoiceText already owns that flow (transcript-as-text with
 * placeholder semantics). Quoted voice and direct/quoted photos, documents,
 * and audio FILES (Bot API `audio`, mapped as media kind 'audio') are read
 * here.
 */

export const TELEGRAM_FILE_REF_PREFIX = 'telegram-file:';

export function telegramFileIdFromRef(url: string | undefined): string | null {
  if (!url?.startsWith(TELEGRAM_FILE_REF_PREFIX)) return null;
  const fileId = url.slice(TELEGRAM_FILE_REF_PREFIX.length);
  return fileId.length > 0 ? fileId : null;
}

function lazyBytes(
  token: string | undefined,
  url: string | undefined,
  buffer: Buffer | undefined,
): () => Promise<Buffer | null> {
  return async () => {
    if (buffer) return buffer;
    const fileId = telegramFileIdFromRef(url);
    if (!fileId || !token) return null;
    return downloadTelegramFile(token, fileId, ATTACHMENT_READ_MAX_BYTES);
  };
}

function mediaAttachment(
  token: string | undefined,
  media: InboundMessage['media'] | InboundMessage['quotedMedia'],
): ReadableAttachment[] {
  if (!media) return [];
  // 'audio' here is an audio FILE (Bot API `audio`, e.g. a shared mp3) —
  // voice notes never reach this collector (see module comment).
  const kind = media.kind === 'image'
    ? 'image'
    : media.kind === 'audio'
      ? 'audio'
      : 'document';
  return [{
    kind,
    contentType: media.contentType,
    ...(media.fileName ? { fileName: media.fileName } : {}),
    bytes: lazyBytes(token, media.url, media.buffer),
  }];
}

function quotedAudioAttachment(
  token: string | undefined,
  audio: InboundMessage['quotedAudio'],
): ReadableAttachment[] {
  if (!audio) return [];
  return [{
    kind: 'audio',
    contentType: audio.contentType,
    ...(audio.ptt === undefined ? {} : { ptt: audio.ptt }),
    bytes: lazyBytes(token, audio.url, audio.buffer),
  }];
}

/**
 * Collect the engaged message's readable attachments — its own first, the
 * replied-to message's as fallback.
 */
export function collectTelegramAttachments(
  m: Pick<InboundMessage, 'media' | 'quotedAudio' | 'quotedMedia'>,
  token: string | undefined,
): ReadableAttachment[] {
  return pickAttachments(
    mediaAttachment(token, m.media),
    [...mediaAttachment(token, m.quotedMedia), ...quotedAudioAttachment(token, m.quotedAudio)],
  );
}
