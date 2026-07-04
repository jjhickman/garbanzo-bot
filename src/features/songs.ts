/**
 * Garbanzo band memory — shared setlist tracking.
 *
 * Owner/band commands:
 *   !song add <title> [key=..] [tempo=..] [status=..]  — add a song
 *   !song list [status]                                — list songs, optionally filtered
 *   !song show <title>                                 — show one song + notes
 *   !song set <title> <field=value>...                 — update fields on a song
 *   !song delete <title>                               — remove a song
 *
 * Fields: key, tempo, status, notes, title (for `set`).
 * Statuses: idea, rough, tight, gig-ready
 */

import {
  addSong,
  deleteSong,
  getSongByTitle,
  listSongs,
  updateSong,
  type Song,
  type SongStatus,
} from '../utils/db.js';

const SONG_STATUSES: readonly SongStatus[] = ['idea', 'rough', 'tight', 'gig-ready'];

const ADD_FIELDS = ['key', 'tempo', 'status'] as const;
const SET_FIELDS = ['title', 'key', 'tempo', 'status', 'notes'] as const;

/**
 * Render a song as a single friendly line, e.g. `Sundown (E, 120bpm, gig-ready)`.
 * Omits key/tempo when not set, e.g. `Sundown (gig-ready)`.
 */
export function formatSongLine(song: Song): string {
  const details: string[] = [];
  if (song.key) details.push(song.key);
  if (song.tempo != null) details.push(`${song.tempo}bpm`);
  details.push(song.status);
  return `${song.title} (${details.join(', ')})`;
}

/**
 * Handle `!song` subcommands. Returns a response string.
 */
export async function handleSongCommand(args: string): Promise<string> {
  const trimmed = args.trim();
  if (!trimmed) return usage();

  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'add':
      return handleAdd(rest);
    case 'list':
      return handleList(rest);
    case 'show':
      return handleShow(rest);
    case 'set':
      return handleSet(rest);
    case 'delete':
    case 'remove':
      return handleDelete(rest);
    default:
      return usage();
  }
}

function usage(): string {
  return [
    '🎵 *Garbanzo Songs*',
    '',
    'Commands:',
    '  `!song add <title> [key=..] [tempo=..] [status=..]` — add a song',
    '  `!song list [status]` — list songs, optionally filtered by status',
    '  `!song show <title>` — show a song and its notes',
    '  `!song set <title> <field=value>...` — update a song (key/tempo/status/notes/title)',
    '  `!song delete <title>` — remove a song',
    '',
    `Statuses: ${SONG_STATUSES.join(', ')}`,
  ].join('\n');
}

function normalizeStatus(value: string): SongStatus | null {
  const normalized = value.trim().toLowerCase();
  return (SONG_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as SongStatus)
    : null;
}

function invalidStatusMessage(value: string): string {
  return `❌ Invalid status "${value}". Valid statuses: ${SONG_STATUSES.join(', ')}.`;
}

/**
 * Split `rest` into a leading title and trailing `field=value` tokens.
 * Fields may appear anywhere after the title; the value for a field runs
 * up to the next recognized field marker (or end of string), so values
 * with spaces (e.g. `notes=needs a bridge`) are supported as long as they
 * aren't followed by another field marker.
 */
function parseTitleAndFields(
  rest: string,
  allowedFields: readonly string[],
): { title: string; fields: Record<string, string> } {
  if (!rest) return { title: '', fields: {} };

  const pattern = new RegExp(`\\b(?:${allowedFields.join('|')})=`, 'gi');
  const matches: { field: string; start: number; valueStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rest)) !== null) {
    matches.push({
      field: match[0].slice(0, -1).toLowerCase(),
      start: match.index,
      valueStart: match.index + match[0].length,
    });
  }

  if (matches.length === 0) {
    return { title: rest.trim(), fields: {} };
  }

  const title = rest.slice(0, matches[0].start).trim();
  const fields: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start : rest.length;
    fields[matches[i].field] = rest.slice(matches[i].valueStart, end).trim();
  }
  return { title, fields };
}

function parseTempo(value: string): number | null {
  const tempo = Number(value);
  return Number.isFinite(tempo) ? tempo : null;
}

async function handleAdd(rest: string): Promise<string> {
  const { title, fields } = parseTitleAndFields(rest, ADD_FIELDS);
  if (!title) {
    return '❌ Usage: `!song add <title> [key=..] [tempo=..] [status=..]`';
  }

  let status: SongStatus | undefined;
  if (fields.status !== undefined) {
    const normalized = normalizeStatus(fields.status);
    if (!normalized) return invalidStatusMessage(fields.status);
    status = normalized;
  }

  let tempo: number | undefined;
  if (fields.tempo !== undefined) {
    const parsed = parseTempo(fields.tempo);
    if (parsed === null) return `❌ Invalid tempo "${fields.tempo}". Use a number, e.g. tempo=120.`;
    tempo = parsed;
  }

  const key = fields.key !== undefined ? fields.key : undefined;

  const song = await addSong({ title, key, tempo, status });
  return `✅ Added: ${formatSongLine(song)}`;
}

async function handleList(rest: string): Promise<string> {
  let status: SongStatus | undefined;
  if (rest) {
    const normalized = normalizeStatus(rest);
    if (!normalized) return invalidStatusMessage(rest);
    status = normalized;
  }

  const songs = await listSongs(status);
  if (songs.length === 0) {
    return status
      ? `🎵 No songs with status "${status}".`
      : '🎵 No songs in the setlist yet. Add one: `!song add <title>`';
  }

  if (status) {
    const lines = [`🎵 *Songs* — ${status} (${songs.length})`, ''];
    for (const song of songs) lines.push(`  ${formatSongLine(song)}`);
    return lines.join('\n');
  }

  const byStatus = new Map<SongStatus, Song[]>();
  for (const song of songs) {
    const group = byStatus.get(song.status) ?? [];
    group.push(song);
    byStatus.set(song.status, group);
  }

  const lines = [`🎵 *Songs* (${songs.length})`, ''];
  for (const st of SONG_STATUSES) {
    const group = byStatus.get(st);
    if (!group || group.length === 0) continue;
    lines.push(`*${st}:*`);
    for (const song of group) lines.push(`  ${formatSongLine(song)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

async function handleShow(title: string): Promise<string> {
  if (!title) return '❌ Usage: `!song show <title>`';

  const song = await getSongByTitle(title);
  if (!song) return `❌ No song found named "${title}".`;

  const lines = [`🎵 ${formatSongLine(song)}`];
  if (song.notes) lines.push('', song.notes);
  return lines.join('\n');
}

async function handleSet(rest: string): Promise<string> {
  const { title, fields } = parseTitleAndFields(rest, SET_FIELDS);
  if (!title) return '❌ Usage: `!song set <title> <field=value>...`';
  if (Object.keys(fields).length === 0) {
    return '❌ Provide at least one field to update, e.g. `!song set Sundown status=tight`.';
  }

  const song = await getSongByTitle(title);
  if (!song) return `❌ No song found named "${title}".`;

  const patch: Partial<{
    title: string;
    key: string | null;
    tempo: number | null;
    status: SongStatus;
    notes: string | null;
  }> = {};

  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.key !== undefined) patch.key = fields.key || null;
  if (fields.notes !== undefined) patch.notes = fields.notes || null;

  if (fields.tempo !== undefined) {
    const parsed = parseTempo(fields.tempo);
    if (parsed === null) return `❌ Invalid tempo "${fields.tempo}". Use a number, e.g. tempo=120.`;
    patch.tempo = parsed;
  }

  if (fields.status !== undefined) {
    const normalized = normalizeStatus(fields.status);
    if (!normalized) return invalidStatusMessage(fields.status);
    patch.status = normalized;
  }

  const updated = await updateSong(song.id, patch);
  if (!updated) return `❌ No song found named "${title}".`;
  return `✅ Updated: ${formatSongLine(updated)}`;
}

async function handleDelete(title: string): Promise<string> {
  if (!title) return '❌ Usage: `!song delete <title>`';

  const song = await getSongByTitle(title);
  if (!song) return `❌ No song found named "${title}".`;

  await deleteSong(song.id);
  return `🗑️ Deleted "${song.title}".`;
}
