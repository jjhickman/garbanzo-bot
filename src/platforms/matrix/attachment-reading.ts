import { pickAttachments, type ReadableAttachment } from '../../core/attachment-reading.js';

/**
 * Matrix collector for the platform-agnostic attachment reader
 * (src/core/attachment-reading.ts).
 *
 * Replies carry only the referenced event id (`m.in_reply_to`), so quoted
 * attachments require fetching that event — the client supplies both the
 * event fetch and the media download as capabilities, and BOTH run lazily
 * here, strictly after the engagement decision in the processor. Media
 * downloads reuse downloadMatrixMedia's declared-size precondition and
 * post-download check; access tokens never appear in URLs or logs. Accepted
 * degradation: media whose event declares no `info.size` fails that
 * precondition and is never read — it becomes a context line instead.
 *
 * Direct audio is deliberately NOT collected: the processor's
 * resolveAudioText already owns that flow (transcript-as-text with
 * placeholder semantics). Quoted audio and direct/quoted visual media and
 * files are read here.
 */

/** Referenced-event shape as returned by matrix-bot-sdk's getEvent. */
export interface MatrixQuotedEventLike {
  type?: string;
  content?: {
    msgtype?: string;
    body?: string;
    url?: string;
    filename?: string;
    info?: { mimetype?: string; size?: number };
  };
}

export interface MatrixAttachmentDeps {
  /** Fetch a referenced event; null on any failure. */
  fetchEvent(roomId: string, eventId: string): Promise<MatrixQuotedEventLike | null>;
  /** Bounded mxc download (declared-size precondition); null on any failure. */
  download(mxcUrl: string, declaredSize: number | undefined): Promise<Buffer | null>;
}

export interface MatrixDirectMediaRef {
  url?: string;
  contentType: string;
  fileName?: string;
  buffer?: Buffer;
  kind: 'image' | 'video' | 'document' | 'audio' | 'sticker';
  size?: number;
}

const QUOTED_MSGTYPE_KINDS: Record<string, ReadableAttachment['kind']> = {
  'm.image': 'image',
  'm.video': 'video',
  'm.audio': 'audio',
  'm.file': 'document',
};

/** Map a fetched replied-to event to a readable attachment, if it holds one. */
export function mapMatrixQuotedAttachment(
  event: MatrixQuotedEventLike,
  deps: MatrixAttachmentDeps,
): ReadableAttachment | null {
  if (event.type !== 'm.room.message') return null;
  const content = event.content;
  const mxcUrl = content?.url;
  if (!content || !mxcUrl) return null;
  const kind = QUOTED_MSGTYPE_KINDS[content.msgtype ?? ''];
  if (!kind) return null;

  const fileName = content.filename ?? content.body;
  return {
    kind,
    contentType: content.info?.mimetype
      ?? (kind === 'audio' ? 'audio/ogg' : 'application/octet-stream'),
    ...(fileName ? { fileName } : {}),
    bytes: () => deps.download(mxcUrl, content.info?.size),
  };
}

function directAttachments(
  media: MatrixDirectMediaRef | undefined,
  deps: MatrixAttachmentDeps | undefined,
): ReadableAttachment[] {
  if (!media) return [];
  const mxcUrl = media.url;
  return [{
    kind: media.kind === 'image' ? 'image' : media.kind === 'video' ? 'video' : 'document',
    contentType: media.contentType,
    ...(media.fileName ? { fileName: media.fileName } : {}),
    bytes: async () => {
      if (media.buffer) return media.buffer;
      if (!mxcUrl || !deps) return null;
      return deps.download(mxcUrl, media.size);
    },
  }];
}

/**
 * Collect the engaged message's readable attachments — its own first, the
 * replied-to event's (fetched lazily) as fallback.
 */
export async function collectMatrixAttachments(params: {
  roomId: string;
  media?: MatrixDirectMediaRef;
  quotedEventId?: string;
  deps?: MatrixAttachmentDeps;
}): Promise<ReadableAttachment[]> {
  const direct = directAttachments(params.media, params.deps);
  if (direct.length > 0 || !params.quotedEventId || !params.deps) return direct;

  const event = await params.deps.fetchEvent(params.roomId, params.quotedEventId);
  if (!event) return [];
  const quoted = mapMatrixQuotedAttachment(event, params.deps);
  return pickAttachments(direct, quoted ? [quoted] : []);
}
