/**
 * Garbanzo band memory — per-song structure (the Headchart seed).
 *
 * Owner/band commands:
 *   !section add <song> <kind> [lyrics=..] [chords=..]              — add a section
 *   !section list <song>                                            — show a song's sections
 *   !section edit <song> <position> [lyrics=..] [chords=..] [kind=..] — update a section
 *   !section move <song> <position> <newPosition>                  — reorder a section
 *   !section remove <song> <position>                               — remove a section
 *
 *   !lyrics show <song>                                              — show a song's lyric sheet
 *   !lyrics set <song> <kind> <lyrics...>                            — add a lyrics section
 *
 * Parsing convention: `<song>` is free-text and may contain spaces (like
 * `!song show <title>`). Every subcommand packs the song title AND a
 * trailing kind/position/newPosition into one string (plus `field=value`
 * tokens for `add`/`edit`, stripped out first via `parseTitleAndFields`). To
 * split what's left between the song title and the trailing token(s), we
 * load all existing songs and greedily match the LONGEST whitespace-token
 * prefix of the remaining text against a song title (case-insensitive) —
 * mirroring `resolveSetlistPrefix` in `setlists.ts` — so "Summer Nights
 * bridge" resolves to the song "Summer Nights" (not "Summer") when both
 * exist, and everything after the matched title is the kind/position(s).
 */

import {
  addSongSection,
  getSongByTitle,
  getSongSections,
  listSongs,
  moveSongSection,
  removeSongSection,
  updateSongSection,
  type SectionKind,
  type Song,
  type SongSection,
} from '../utils/db.js';
import { parseTitleAndFields } from './songs.js';

const SECTION_KINDS: readonly SectionKind[] = ['intro', 'verse', 'chorus', 'bridge', 'solo', 'outro', 'other'];

const ADD_FIELDS = ['lyrics', 'chords'] as const;
const EDIT_FIELDS = ['lyrics', 'chords', 'kind'] as const;

/**
 * Render a single section as `${position}. [${kind}] ${lyrics}`, with a
 * `chords:` line appended when chords are present. Handles null lyrics
 * (renders a friendly placeholder instead of the literal "null").
 */
export function formatSection(section: SongSection): string {
  const lyricsText = section.lyrics ?? '(no lyrics yet)';
  const lines = [`${section.position}. [${section.kind}] ${lyricsText}`];
  if (section.chords) lines.push(`   chords: ${section.chords}`);
  return lines.join('\n');
}

/**
 * Render a song's full sheet: a header (title) followed by its sections in
 * position order, or a friendly "(no sections yet)" message when empty.
 */
export function formatSongSheet(song: Song, sections: SongSection[]): string {
  const lines = [`🎼 *${song.title}*`, ''];
  if (sections.length === 0) {
    lines.push('(no sections yet)');
  } else {
    for (const section of sections) lines.push(formatSection(section));
  }
  return lines.join('\n');
}

/**
 * Handle `!section` subcommands. Returns a response string.
 */
export async function handleSectionCommand(args: string): Promise<string> {
  const trimmed = args.trim();
  if (!trimmed) return sectionUsage();

  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'add':
      return handleAdd(rest);
    case 'list':
      return handleList(rest);
    case 'edit':
      return handleEdit(rest);
    case 'move':
      return handleMove(rest);
    case 'remove':
      return handleRemove(rest);
    default:
      return sectionUsage();
  }
}

/**
 * Handle `!lyrics` subcommands. Returns a response string.
 */
export async function handleLyricsCommand(args: string): Promise<string> {
  const trimmed = args.trim();
  if (!trimmed) return lyricsUsage();

  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'show':
      return handleLyricsShow(rest);
    case 'set':
      return handleLyricsSet(rest);
    default:
      return lyricsUsage();
  }
}

function sectionUsage(): string {
  return [
    '🎼 *Remy Song Sections*',
    '',
    'Commands:',
    '  `!section add <song> <kind> [lyrics=..] [chords=..]` — add a section',
    '  `!section list <song>` — show a song\'s sections',
    '  `!section edit <song> <position> [lyrics=..] [chords=..] [kind=..]` — update a section',
    '  `!section move <song> <position> <newPosition>` — reorder a section',
    '  `!section remove <song> <position>` — remove a section',
    '',
    `Kinds: ${SECTION_KINDS.join(', ')}`,
    '',
    'Note: `<song>` may be multiple words (e.g. "Chickpea Boogie") — it\'s matched against your existing song titles, longest match wins.',
  ].join('\n');
}

function lyricsUsage(): string {
  return [
    '📝 *Remy Lyrics*',
    '',
    'Commands:',
    '  `!lyrics show <song>` — show a song\'s lyric sheet',
    '  `!lyrics set <song> <kind> <lyrics...>` — add a lyrics section',
    '',
    `Kinds: ${SECTION_KINDS.join(', ')}`,
    '',
    'Note: `<song>` may be multiple words (e.g. "Chickpea Boogie") — it\'s matched against your existing song titles, longest match wins.',
  ].join('\n');
}

/**
 * Resolve a song title from the start of `text` by longest-prefix match:
 * among all existing songs whose (case-insensitive) title is a
 * whitespace-token prefix of `text`, pick the one with the most tokens.
 * Mirrors `resolveSetlistPrefix` in `setlists.ts`.
 *
 * Returns the matched song and the remaining text (kind/position/etc.), or
 * `null` if no existing song title is a prefix of `text`.
 */
async function resolveSongPrefix(text: string): Promise<{ song: Song; remainder: string } | null> {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const songs = await listSongs();
  let best: { song: Song; tokenCount: number } | null = null;
  for (const song of songs) {
    const titleTokens = song.title.trim().split(/\s+/).filter(Boolean);
    if (titleTokens.length === 0 || titleTokens.length > tokens.length) continue;

    const isPrefix = titleTokens.every((token, i) => token.toLowerCase() === tokens[i].toLowerCase());
    if (isPrefix && (best === null || titleTokens.length > best.tokenCount)) {
      best = { song, tokenCount: titleTokens.length };
    }
  }

  if (best === null) return null;
  return { song: best.song, remainder: tokens.slice(best.tokenCount).join(' ') };
}

function normalizeKind(value: string): SectionKind | null {
  const normalized = value.trim().toLowerCase();
  return (SECTION_KINDS as readonly string[]).includes(normalized) ? (normalized as SectionKind) : null;
}

function invalidKindMessage(value: string): string {
  return `❌ Invalid kind "${value}". Valid kinds: ${SECTION_KINDS.join(', ')}.`;
}

function parsePosition(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const position = Number(trimmed);
  return Number.isInteger(position) && position > 0 ? position : null;
}

async function findSectionAtPosition(songId: number, position: number): Promise<SongSection | undefined> {
  const sections = await getSongSections(songId);
  return sections.find((section) => section.position === position);
}

async function handleAdd(rest: string): Promise<string> {
  const { title: songAndKind, fields } = parseTitleAndFields(rest, ADD_FIELDS);
  if (!songAndKind) {
    return '❌ Usage: `!section add <song> <kind> [lyrics=..] [chords=..]`';
  }

  const resolved = await resolveSongPrefix(songAndKind);
  if (!resolved) return `❌ No song found named "${songAndKind}".`;

  const { song, remainder: kindStr } = resolved;
  if (!kindStr) {
    return '❌ Usage: `!section add <song> <kind> [lyrics=..] [chords=..]`';
  }

  const kind = normalizeKind(kindStr);
  if (!kind) return invalidKindMessage(kindStr);

  const section = await addSongSection({
    songId: song.id,
    kind,
    lyrics: fields.lyrics || undefined,
    chords: fields.chords || undefined,
  });

  return `✅ Added section to *${song.title}*: ${formatSection(section)}`;
}

async function handleList(rest: string): Promise<string> {
  const title = rest.trim();
  if (!title) return '❌ Usage: `!section list <song>`';

  const song = await getSongByTitle(title);
  if (!song) return `❌ No song found named "${title}".`;

  const sections = await getSongSections(song.id);
  return formatSongSheet(song, sections);
}

async function handleEdit(rest: string): Promise<string> {
  const { title: songAndPosition, fields } = parseTitleAndFields(rest, EDIT_FIELDS);
  if (!songAndPosition) {
    return '❌ Usage: `!section edit <song> <position> [lyrics=..] [chords=..] [kind=..]`';
  }

  const resolved = await resolveSongPrefix(songAndPosition);
  if (!resolved) return `❌ No song found named "${songAndPosition}".`;

  const { song, remainder: positionStr } = resolved;
  const position = parsePosition(positionStr);
  if (position === null) {
    return `❌ Invalid position "${positionStr}". Use a positive whole number, e.g. \`!section edit ${song.title} 1 lyrics=...\`.`;
  }

  const target = await findSectionAtPosition(song.id, position);
  if (!target) return `❌ No section at position ${position} for "${song.title}".`;

  let kind: SectionKind | undefined;
  if (fields.kind !== undefined) {
    const normalized = normalizeKind(fields.kind);
    if (!normalized) return invalidKindMessage(fields.kind);
    kind = normalized;
  }

  const patch: Partial<{ kind: SectionKind; lyrics: string | null; chords: string | null }> = {};
  if (kind !== undefined) patch.kind = kind;
  if (fields.lyrics !== undefined) patch.lyrics = fields.lyrics || null;
  if (fields.chords !== undefined) patch.chords = fields.chords || null;

  if (Object.keys(patch).length === 0) {
    return `❌ Provide at least one field to update, e.g. \`!section edit ${song.title} ${position} lyrics=...\`.`;
  }

  const updated = await updateSongSection(target.id, patch);
  if (!updated) return `❌ No section at position ${position} for "${song.title}".`;

  return `✅ Updated section ${formatSection(updated)}`;
}

async function handleMove(rest: string): Promise<string> {
  const resolved = await resolveSongPrefix(rest);
  if (!resolved) return `❌ No song found named "${rest.trim()}".`;

  const { song, remainder } = resolved;
  const tokens = remainder.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) {
    return '❌ Usage: `!section move <song> <position> <newPosition>`';
  }

  const position = parsePosition(tokens[0]);
  const newPosition = parsePosition(tokens[1]);
  if (position === null || newPosition === null) {
    return `❌ Invalid position. Use positive whole numbers, e.g. \`!section move ${song.title} 1 2\`.`;
  }

  const target = await findSectionAtPosition(song.id, position);
  if (!target) return `❌ No section at position ${position} for "${song.title}".`;

  const moved = await moveSongSection(target.id, newPosition);
  if (!moved) return `❌ Could not move section for "${song.title}".`;

  return `✅ Moved section to position ${newPosition} on *${song.title}*.`;
}

async function handleRemove(rest: string): Promise<string> {
  const resolved = await resolveSongPrefix(rest);
  if (!resolved) return `❌ No song found named "${rest.trim()}".`;

  const { song, remainder: positionStr } = resolved;
  const position = parsePosition(positionStr);
  if (position === null) {
    return `❌ Invalid position "${positionStr}". Use a positive whole number, e.g. \`!section remove ${song.title} 1\`.`;
  }

  const target = await findSectionAtPosition(song.id, position);
  if (!target) return `❌ No section at position ${position} for "${song.title}".`;

  const removed = await removeSongSection(target.id);
  if (!removed) return `❌ Could not remove section for "${song.title}".`;

  return `🗑️ Removed section from *${song.title}*.`;
}

async function handleLyricsShow(rest: string): Promise<string> {
  const title = rest.trim();
  if (!title) return '❌ Usage: `!lyrics show <song>`';

  const song = await getSongByTitle(title);
  if (!song) return `❌ No song found named "${title}".`;

  const sections = await getSongSections(song.id);
  return formatSongSheet(song, sections);
}

async function handleLyricsSet(rest: string): Promise<string> {
  const trimmed = rest.trim();
  if (!trimmed) return '❌ Usage: `!lyrics set <song> <kind> <lyrics...>`';

  const resolved = await resolveSongPrefix(trimmed);
  if (!resolved) return `❌ No song found named "${trimmed}".`;

  const { song, remainder } = resolved;
  const spaceIdx = remainder.indexOf(' ');
  const kindStr = (spaceIdx === -1 ? remainder : remainder.slice(0, spaceIdx)).trim();
  const lyrics = spaceIdx === -1 ? '' : remainder.slice(spaceIdx + 1).trim();

  if (!kindStr) return '❌ Usage: `!lyrics set <song> <kind> <lyrics...>`';

  const kind = normalizeKind(kindStr);
  if (!kind) return invalidKindMessage(kindStr);

  if (!lyrics) return '❌ Usage: `!lyrics set <song> <kind> <lyrics...>` — lyrics text is required.';

  const section = await addSongSection({ songId: song.id, kind, lyrics });
  return `✅ Added lyrics to *${song.title}*: ${formatSection(section)}`;
}
