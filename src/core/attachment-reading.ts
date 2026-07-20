import { prepareForVision, type VisionImage, type VisionMediaType } from './vision.js';
import { transcribeAudio } from '../features/voice.js';
import { logger } from '../middleware/logger.js';

/**
 * Platform-agnostic attachment reading for the reply path.
 *
 * Each platform supplies `ReadableAttachment[]` for an ENGAGED message
 * (its own attachments first, the replied-to message's as fallback) and this
 * module turns them into vision payloads and query context:
 *
 * - visual (image/video/sticker/gif) → `prepareForVision` (first visual only)
 * - audio → Whisper transcript appended as `[voice message transcript] …`
 * - documents / unreadable / failed reads → `[attachment: name (type)]` line
 *
 * Byte access is lazy (`bytes()`), bounded by the collector, and only ever
 * invoked here — strictly AFTER the engagement decision and never for bang
 * commands (feature handlers own their raw queries). Any failure degrades to
 * a context line; nothing in this module can drop or crash the reply.
 */

/** Independent of the bridge media cap: attachment reading is a reply feature. */
export const ATTACHMENT_READ_MAX_BYTES = 8 * 1024 * 1024;

export type ReadableAttachmentKind = VisionMediaType | 'audio' | 'document' | 'unknown';

export interface ReadableAttachment {
  kind: ReadableAttachmentKind;
  contentType: string;
  fileName?: string;
  /** Attachment's own caption; falls back to the query for vision context. */
  caption?: string;
  /** Push-to-talk voice note (vs a shared audio file), where known. */
  ptt?: boolean;
  /**
   * Lazy, bounded download supplied by the platform collector. Returns null
   * on any failure (oversize, timeout, transport error) — never throws by
   * contract, but a throw is tolerated and degrades to a context line.
   */
  bytes(): Promise<Buffer | null>;
}

export interface AttachmentReadResult {
  visionImages?: VisionImage[];
  enrichedQuery: string;
}

const VISUAL_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'sticker', 'gif']);

/**
 * Context line for attachments the bot cannot ingest (documents, failed
 * vision/transcription) so the model can refer to them honestly instead of
 * being blind.
 */
export function attachmentContextLine(att: {
  fileName?: string;
  contentType: string;
  kind?: ReadableAttachmentKind;
}): string {
  const name = att.fileName ?? (att.kind === 'audio' ? 'voice message' : 'file');
  return `[attachment: ${name} (${att.contentType})]`;
}

/**
 * The engaging message's own attachments always win; the replied-to
 * message's attachments are read only when the engaging message has none.
 */
export function pickAttachments(
  direct: ReadableAttachment[],
  quoted: ReadableAttachment[],
): ReadableAttachment[] {
  return direct.length > 0 ? direct : quoted;
}

async function readVisual(att: ReadableAttachment, query: string): Promise<VisionImage[] | undefined> {
  try {
    const data = await att.bytes();
    if (!data) return undefined;
    const images = await prepareForVision({
      type: att.kind as VisionMediaType,
      data,
      mimeType: att.contentType,
      caption: att.caption ?? (query.length > 0 ? query : undefined),
    });
    return images.length > 0 ? images : undefined;
  } catch (err) {
    logger.warn(
      { err, contentType: att.contentType, fileName: att.fileName },
      'Attachment vision preparation failed',
    );
    return undefined;
  }
}

/**
 * Gated on an explicit WHISPER_URL (matching the bridge and song-ideas
 * convention) so deployments without a transcription server never pay a
 * doomed download per audio attachment.
 */
async function readAudio(att: ReadableAttachment): Promise<string | null> {
  if (!process.env.WHISPER_URL) return null;
  try {
    const data = await att.bytes();
    if (!data) return null;
    const transcript = await transcribeAudio(data, att.contentType);
    const clean = transcript?.trim();
    return clean ? clean : null;
  } catch (err) {
    logger.warn(
      { err, contentType: att.contentType, fileName: att.fileName },
      'Attachment transcription failed',
    );
    return null;
  }
}

/**
 * Read an engaged message's attachments into `{ visionImages, enrichedQuery }`.
 * Callers pass the mention-stripped query; the result's `enrichedQuery`
 * replaces it in the AI dispatch (bang commands must never reach here).
 */
export async function readAttachments(
  attachments: ReadableAttachment[],
  query: string,
): Promise<AttachmentReadResult> {
  let visionImages: VisionImage[] | undefined;
  const lines: string[] = [];

  for (const att of attachments) {
    if (VISUAL_KINDS.has(att.kind) && !visionImages) {
      const images = await readVisual(att, query);
      if (images) {
        visionImages = images;
        continue;
      }
      lines.push(attachmentContextLine(att));
      continue;
    }

    if (att.kind === 'audio') {
      const transcript = await readAudio(att);
      lines.push(transcript ? `[voice message transcript] ${transcript}` : attachmentContextLine(att));
      continue;
    }

    lines.push(attachmentContextLine(att));
  }

  let enrichedQuery = query;
  for (const line of lines) {
    enrichedQuery = enrichedQuery ? `${enrichedQuery}\n\n${line}` : line;
  }

  return { visionImages, enrichedQuery };
}
