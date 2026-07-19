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

export interface TelegramMappedMedia {
  fileId: string;
  mimeType: string;
  fileName: string;
  kind: 'image' | 'document';
  size?: number;
}

export function mapTelegramMedia(message: {
  photo?: RawTelegramPhoto[];
  document?: RawTelegramDocument;
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
  kind: 'image' | 'document';
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
