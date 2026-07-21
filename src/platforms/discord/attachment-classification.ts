/**
 * Shared Discord attachment classification.
 *
 * One implementation for both attachment shapes the bot sees:
 * - Gateway path: discord.js `Attachment` structures (camelCase getters —
 *   `contentType`, `name`) off `message.attachments`.
 * - REST path: plain API objects (snake_case — `content_type`, `filename`)
 *   from `GET /channels/{channelId}/messages/{messageId}`, used by the
 *   adapter's lazy referenced-message fetch.
 *
 * The readers duck-type both shapes; keep it that way.
 */

export interface DiscordClassifiedAudio {
  url: string;
  contentType: string;
}

export interface DiscordClassifiedMedia {
  url: string;
  contentType: string;
  fileName?: string;
  kind: 'image' | 'video' | 'document';
}

/** Readable attachments of a (referenced) Discord message, by class. */
export interface DiscordMessageAttachments {
  audio?: DiscordClassifiedAudio;
  media?: DiscordClassifiedMedia;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

const AUDIO_EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

function inferAudioContentTypeFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  const extension = Object.keys(AUDIO_EXTENSION_CONTENT_TYPES).find((ext) => lower.endsWith(ext));
  return extension ? AUDIO_EXTENSION_CONTENT_TYPES[extension] : undefined;
}

export function readAudioAttachment(attachments: unknown[]): DiscordClassifiedAudio | undefined {
  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue;

    const url = readString(attachment, 'url');
    if (!url) continue;

    const declaredContentType = readString(attachment, 'contentType') ?? readString(attachment, 'content_type');
    const filename = readString(attachment, 'name') ?? readString(attachment, 'filename');
    const inferredContentType = inferAudioContentTypeFromName(filename) ?? inferAudioContentTypeFromName(url);

    if (declaredContentType?.startsWith('audio/')) {
      return { url, contentType: declaredContentType };
    }

    if (inferredContentType) {
      // Extension says audio but the declared type isn't audio/* (Discord emits
      // e.g. application/octet-stream for some containers) — trust the inferred
      // audio type so the transcription consumer gets a usable MIME.
      return { url, contentType: inferredContentType };
    }
  }

  return undefined;
}

export function readMediaAttachment(attachments: unknown[]): DiscordClassifiedMedia | undefined {
  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue;
    const url = readString(attachment, 'url');
    if (!url) continue;

    const contentType = readString(attachment, 'contentType')
      ?? readString(attachment, 'content_type')
      ?? 'application/octet-stream';
    const fileName = readString(attachment, 'name') ?? readString(attachment, 'filename');
    if (contentType.startsWith('audio/') || inferAudioContentTypeFromName(fileName ?? url)) continue;

    const kind = contentType.startsWith('image/')
      ? 'image'
      : contentType.startsWith('video/')
        ? 'video'
        : 'document';
    return { url, contentType, ...(fileName ? { fileName } : {}), kind };
  }
  return undefined;
}

/** Classify a message's attachment list; null when nothing is readable. */
export function classifyDiscordMessageAttachments(attachments: unknown[]): DiscordMessageAttachments | null {
  const audio = readAudioAttachment(attachments);
  const media = readMediaAttachment(attachments);
  if (!audio && !media) return null;
  return { ...(audio ? { audio } : {}), ...(media ? { media } : {}) };
}
