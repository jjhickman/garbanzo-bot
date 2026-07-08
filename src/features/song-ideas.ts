/**
 * Remy songwriting scratchpad — quick song idea capture, shared band memory.
 *
 * Owner/band commands:
 *   !idea capture [title] [text=..]  — save a text idea (drop/attach an
 *                                       audio clip to capture + transcribe it
 *                                       via Whisper instead of typing text)
 *   !idea list                       — list recent ideas
 *   !idea show <id>                  — show an idea's full detail
 *   !idea promote <id> [title]       — turn an idea into a catalog song
 *                                       (status: idea) and link them
 *   !idea delete <id>                — delete an idea
 *
 * Capture parsing convention: without an explicit `text=` field, the entire
 * remainder of the command is treated as free-text `text` (e.g.
 * `!idea capture verse about chickpeas and highways`) — there's no title in
 * that case. To set BOTH a title and text, use `text=`: everything before it
 * is the title, everything after is the text (e.g.
 * `!idea capture Ocean riff text=verse about waves`). When an audio clip is
 * attached, the remainder (minus any `text=` field) is instead treated as the
 * title, since the clip itself supplies the content via transcription.
 */

import { logger } from '../middleware/logger.js';
import {
  addSong,
  addSongIdea,
  deleteSongIdea,
  getSongIdeaById,
  linkSongIdeaToSong,
  listSongIdeas,
  type SongIdea,
} from '../utils/db.js';
import { transcribeAudio } from './voice.js';
import { parseTitleAndFields } from './songs.js';

const CAPTURE_FIELDS = ['text'] as const;
const LIST_LIMIT = 20;
const SNIPPET_MAX_LENGTH = 60;
const FETCH_TIMEOUT_MS = 30_000;

export interface IdeaCommandContext {
  senderId: string;
  // `buffer` is Telegram-only (F1, T2 review): Telegram's `url` is a safe,
  // non-fetchable placeholder (`telegram-file:<id>`, never the token-bearing
  // real file URL — see telegram-voice.ts), so `fetchAndTranscribe(url)`
  // alone can never work for Telegram voice. When `buffer` is present, it's
  // the already-downloaded audio and takes priority over fetching `url`.
  audio?: { url: string; contentType: string; buffer?: Buffer };
}

export async function handleIdeaCommand(args: string, ctx: IdeaCommandContext): Promise<string> {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'capture':
      return handleCapture(rest, ctx);
    case 'list':
      return handleList();
    case 'show':
      return handleShow(rest);
    case 'promote':
      return handlePromote(rest);
    case 'delete':
      return handleDelete(rest);
    default:
      return usage();
  }
}

export function formatIdeaLine(idea: SongIdea): string {
  const parts = [`#${idea.id}`];
  if (idea.title) parts.push(`"${idea.title}"`);

  const snippet = ideaSnippet(idea);
  if (snippet) parts.push(`— ${truncate(snippet, SNIPPET_MAX_LENGTH)}`);

  return parts.join(' ');
}

/**
 * Download an audio clip and transcribe it via Whisper. Returns `null` on
 * ANY failure (network error, non-OK response, or a failed/empty
 * transcription) — never throws, so a bad/hung download can't take down the
 * capture flow. A ~30s timeout guards against a hung fetch.
 */
export async function fetchAndTranscribe(url: string, contentType: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    // The timeout must bound the whole download (request + body read), not just
    // the initial response — aborting the signal cancels an in-flight
    // arrayBuffer() too, so clear it only after the body is fully read.
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let buffer: Buffer;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'Song idea audio fetch failed');
        return null;
      }
      buffer = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }

    return await transcribeAudio(buffer, contentType);
  } catch (err) {
    logger.warn({ err, url }, 'Song idea audio fetch/transcription failed');
    return null;
  }
}

function usage(): string {
  return [
    '💡 *Remy Song Ideas*',
    '',
    'Commands:',
    '  `!idea capture [title] [text=..]` — save a text idea (or attach/drop an audio clip to capture + transcribe it)',
    '  `!idea list` — list recent ideas',
    '  `!idea show <id>` — show an idea\'s full detail',
    '  `!idea promote <id> [title]` — turn an idea into a song (status: idea)',
    '  `!idea delete <id>` — delete an idea',
  ].join('\n');
}

async function handleCapture(rest: string, ctx: IdeaCommandContext): Promise<string> {
  const hasAudio = ctx.audio !== undefined;
  const { title, fields } = parseTitleAndFields(rest, CAPTURE_FIELDS);

  // With audio attached, the free text is the title (the clip supplies the
  // content). Without audio, an explicit `text=` field splits title/text;
  // otherwise the whole remainder is the text (no title).
  const captureTitle = hasAudio || fields.text !== undefined ? (title || undefined) : undefined;
  const text = hasAudio
    ? (fields.text || undefined)
    : (fields.text !== undefined ? (fields.text || undefined) : (title || undefined));

  if (!hasAudio && !text && !captureTitle) {
    return '❌ Usage: `!idea capture <text>` (or `!idea capture <title> text=<text>`), or drop/attach an audio clip.';
  }

  let transcript: string | null | undefined;
  if (hasAudio && ctx.audio) {
    // Prefer an already-downloaded buffer (Telegram) over fetching `url`
    // (Discord CDN url) — F1, T2 review.
    transcript = ctx.audio.buffer
      ? await transcribeAudio(ctx.audio.buffer, ctx.audio.contentType)
      : await fetchAndTranscribe(ctx.audio.url, ctx.audio.contentType);
  }

  const idea = await addSongIdea({
    title: captureTitle,
    text,
    audioUrl: ctx.audio?.url,
    transcript,
    createdBy: ctx.senderId,
  });

  const lines = [`✅ Captured: ${formatIdeaLine(idea)}`];
  if (hasAudio && transcript === null) {
    lines.push('⚠️ Audio saved, but transcription was unavailable right now — the clip is still stored.');
  }
  return lines.join('\n');
}

async function handleList(): Promise<string> {
  const ideas = await listSongIdeas(LIST_LIMIT);
  if (ideas.length === 0) {
    return '💡 No song ideas yet. Capture one: `!idea capture <text>` or drop an audio clip.';
  }

  const lines = [`💡 *Song Ideas* (${ideas.length})`, ''];
  for (const idea of ideas) lines.push(`  ${formatIdeaLine(idea)}`);
  return lines.join('\n');
}

async function handleShow(idText: string): Promise<string> {
  const id = parseIdeaId(idText);
  if (id === null) return '❌ Usage: `!idea show <id>`';

  const idea = await getSongIdeaById(id);
  if (!idea) return `❌ No song idea found with id #${id}.`;

  const lines = [`💡 Idea #${idea.id}${idea.title ? `: *${idea.title}*` : ''}`];
  if (idea.text) lines.push('', idea.text);
  if (idea.transcript) lines.push('', `Transcript: ${idea.transcript}`);
  if (idea.audioUrl) lines.push('', `🎧 Audio: ${idea.audioUrl}`);
  if (idea.songId) lines.push('', `Linked to song #${idea.songId}`);
  return lines.join('\n');
}

async function handlePromote(rest: string): Promise<string> {
  const trimmed = rest.trim();
  const spaceIdx = trimmed.indexOf(' ');
  const idText = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const titleOverride = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  const id = parseIdeaId(idText);
  if (id === null) return '❌ Usage: `!idea promote <id> [title]`';

  const idea = await getSongIdeaById(id);
  if (!idea) return `❌ No song idea found with id #${id}.`;

  const title = titleOverride || idea.title || 'Untitled';
  const song = await addSong({ title, status: 'idea' });
  await linkSongIdeaToSong(idea.id, song.id);

  return `✅ Promoted idea #${idea.id} to song *${song.title}* (#${song.id}, status: idea).`;
}

async function handleDelete(idText: string): Promise<string> {
  const id = parseIdeaId(idText);
  if (id === null) return '❌ Usage: `!idea delete <id>`';

  const deleted = await deleteSongIdea(id);
  if (!deleted) return `❌ No song idea found with id #${id}.`;
  return `🗑️ Deleted idea #${id}.`;
}

function ideaSnippet(idea: SongIdea): string | null {
  if (idea.text) return idea.text;
  if (idea.transcript) return idea.transcript;
  if (idea.audioUrl) return '(audio, no transcript)';
  return null;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function parseIdeaId(value: string): number | null {
  const id = Number(value.trim().replace(/^#/, ''));
  return Number.isInteger(id) && id > 0 ? id : null;
}
