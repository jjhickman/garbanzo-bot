import { getBridgeMediaMaxBytes, isBridgeMediaEnabled } from '../../utils/config/bridge.js';
import { downloadTelegramFile } from './telegram-voice.js';

export interface RawTelegramPhoto {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface RawTelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Bot API `Audio` — an audio FILE (mp3 shared as music), not a voice note. */
export interface RawTelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMappedMedia {
  fileId: string;
  mimeType: string;
  fileName: string;
  kind: 'image' | 'document' | 'audio';
  size?: number;
}

export function mapTelegramMedia(message: {
  photo?: RawTelegramPhoto[];
  document?: RawTelegramDocument;
  audio?: RawTelegramAudio;
}): TelegramMappedMedia | undefined {
  const photo = message.photo?.at(-1);
  if (photo) {
    return {
      fileId: photo.file_id,
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      kind: 'image',
      ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
    };
  }
  // Audio FILES only (`message.audio`) — voice notes (`message.voice`) stay
  // with the processor's transcript-as-text flow, never mapped as media.
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type ?? 'audio/mpeg',
      fileName: message.audio.file_name ?? 'audio',
      kind: 'audio',
      ...(message.audio.file_size === undefined ? {} : { size: message.audio.file_size }),
    };
  }
  if (!message.document) return undefined;
  return {
    fileId: message.document.file_id,
    mimeType: message.document.mime_type ?? 'application/octet-stream',
    fileName: message.document.file_name ?? 'document',
    kind: 'document',
    ...(message.document.file_size === undefined ? {} : { size: message.document.file_size }),
  };
}

export async function prepareTelegramMedia(
  token: string,
  media: TelegramMappedMedia,
  chatAllowsDownload: boolean,
): Promise<{
  url: string;
  contentType: string;
  fileName: string;
  kind: TelegramMappedMedia['kind'];
  buffer?: Buffer;
}> {
  const maxBytes = getBridgeMediaMaxBytes();
  const canDownload = isBridgeMediaEnabled()
    && chatAllowsDownload
    && (media.size === undefined || media.size <= maxBytes);
  const buffer = canDownload
    ? await downloadTelegramFile(token, media.fileId, maxBytes)
    : null;
  return {
    url: `telegram-file:${media.fileId}`,
    contentType: media.mimeType,
    fileName: media.fileName,
    kind: media.kind,
    ...(buffer ? { buffer } : {}),
  };
}
