/**
 * Garbanzo band memory — setlists (ordered lists of songs from the shared
 * song catalog).
 *
 * Owner/band commands:
 *   !setlist create <name> [notes=..]                  — create a setlist
 *   !setlist list                                       — list all setlists
 *   !setlist show <name>                                — show a setlist and its songs
 *   !setlist add <name> <songTitle> [position=..]       — add a song to a setlist
 *   !setlist remove <name> <songTitle>                  — remove a song from a setlist
 *   !setlist move <name> <songTitle> <position>         — reorder a song
 *   !setlist delete <name>                               — delete a setlist
 *
 * Parsing convention: `create`/`show`/`delete` take a single free-text `<name>`
 * (like `!song show <title>`, it may contain spaces). `add`/`remove`/`move`
 * need BOTH a setlist name AND a song title in one string, so to keep parsing
 * deterministic the setlist `<name>` there is the first whitespace-delimited
 * token only; everything after it is the song title (plus a trailing
 * `position=N` field for `add`, or a trailing integer for `move`).
 */

import {
  addSetlist,
  addSongToSetlist,
  deleteSetlist,
  getSetlistByName,
  getSetlistSongs,
  getSongByTitle,
  listSetlists,
  moveSetlistSong,
  removeSongFromSetlist,
  type Setlist,
  type SetlistEntry,
} from '../utils/db.js';
import { formatSongLine, parseTitleAndFields } from './songs.js';

const CREATE_FIELDS = ['notes'] as const;
const ADD_FIELDS = ['position'] as const;

/**
 * Render a setlist as a header (name + notes) followed by a numbered list of
 * its songs, one line per entry: `${position}. ${formatSongLine(song)}`.
 */
export function formatSetlist(setlist: Setlist, entries: SetlistEntry[]): string {
  const lines = [`📋 *${setlist.name}*`];
  if (setlist.notes) lines.push(setlist.notes);
  lines.push('');

  if (entries.length === 0) {
    lines.push('(empty)');
  } else {
    for (const entry of entries) {
      lines.push(`${entry.position}. ${formatSongLine(entry.song)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Handle `!setlist` subcommands. Returns a response string.
 */
export async function handleSetlistCommand(args: string): Promise<string> {
  const trimmed = args.trim();
  if (!trimmed) return usage();

  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'create':
      return handleCreate(rest);
    case 'list':
      return handleList();
    case 'show':
      return handleShow(rest);
    case 'add':
      return handleAdd(rest);
    case 'remove':
      return handleRemove(rest);
    case 'move':
      return handleMove(rest);
    case 'delete':
      return handleDelete(rest);
    default:
      return usage();
  }
}

function usage(): string {
  return [
    '📋 *Remy Setlists*',
    '',
    'Commands:',
    '  `!setlist create <name> [notes=..]` — create a setlist',
    '  `!setlist list` — list all setlists',
    '  `!setlist show <name>` — show a setlist and its songs',
    '  `!setlist add <name> <songTitle> [position=..]` — add a song to a setlist',
    '  `!setlist remove <name> <songTitle>` — remove a song from a setlist',
    '  `!setlist move <name> <songTitle> <position>` — reorder a song',
    '  `!setlist delete <name>` — delete a setlist',
    '',
    'Note: for `add`/`remove`/`move`, `<name>` is a single word (the first token) — song titles may still be multiple words.',
  ].join('\n');
}

/** Split `rest` into a leading single-word token and the remainder. */
function splitFirstToken(rest: string): { first: string; remainder: string } {
  const trimmed = rest.trim();
  const spaceIdx = trimmed.indexOf(' ');
  return spaceIdx === -1
    ? { first: trimmed, remainder: '' }
    : { first: trimmed.slice(0, spaceIdx), remainder: trimmed.slice(spaceIdx + 1).trim() };
}

function parsePosition(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const position = Number(trimmed);
  return Number.isInteger(position) && position > 0 ? position : null;
}

async function handleCreate(rest: string): Promise<string> {
  const { title: name, fields } = parseTitleAndFields(rest, CREATE_FIELDS);
  if (!name) {
    return '❌ Usage: `!setlist create <name> [notes=..]`';
  }

  const existing = await getSetlistByName(name);
  if (existing) {
    return `❌ A setlist named "${name}" already exists.`;
  }

  const setlist = await addSetlist({ name, notes: fields.notes || undefined });
  return `✅ Created setlist: *${setlist.name}*`;
}

async function handleList(): Promise<string> {
  const setlists = await listSetlists();
  if (setlists.length === 0) {
    return '📋 No setlists yet. Create one: `!setlist create <name>`';
  }

  const lines = [`📋 *Setlists* (${setlists.length})`, ''];
  for (const setlist of setlists) lines.push(`  ${setlist.name}`);
  return lines.join('\n');
}

async function handleShow(name: string): Promise<string> {
  if (!name) return '❌ Usage: `!setlist show <name>`';

  const setlist = await getSetlistByName(name);
  if (!setlist) return `❌ No setlist found named "${name}".`;

  const entries = await getSetlistSongs(setlist.id);
  return formatSetlist(setlist, entries);
}

async function handleAdd(rest: string): Promise<string> {
  const { first: name, remainder } = splitFirstToken(rest);
  const { title, fields } = parseTitleAndFields(remainder, ADD_FIELDS);
  if (!name || !title) {
    return '❌ Usage: `!setlist add <name> <songTitle> [position=..]`';
  }

  let position: number | undefined;
  if (fields.position !== undefined) {
    const parsed = parsePosition(fields.position);
    if (parsed === null) return `❌ Invalid position "${fields.position}". Use a positive whole number, e.g. position=2.`;
    position = parsed;
  }

  const setlist = await getSetlistByName(name);
  if (!setlist) return `❌ No setlist found named "${name}".`;

  const song = await getSongByTitle(title);
  if (!song) return `❌ No song found named "${title}".`;

  await addSongToSetlist(setlist.id, song.id, position);
  return `✅ Added ${formatSongLine(song)} to *${setlist.name}*.`;
}

async function handleRemove(rest: string): Promise<string> {
  const { first: name, remainder: title } = splitFirstToken(rest);
  if (!name || !title) {
    return '❌ Usage: `!setlist remove <name> <songTitle>`';
  }

  const setlist = await getSetlistByName(name);
  if (!setlist) return `❌ No setlist found named "${name}".`;

  const song = await getSongByTitle(title);
  if (!song) return `❌ No song found named "${title}".`;

  const removed = await removeSongFromSetlist(setlist.id, song.id);
  if (!removed) return `❌ "${song.title}" is not on *${setlist.name}*.`;

  return `🗑️ Removed ${formatSongLine(song)} from *${setlist.name}*.`;
}

async function handleMove(rest: string): Promise<string> {
  const { first: name, remainder } = splitFirstToken(rest);
  const match = /^(.*\S)\s+(-?\S+)$/.exec(remainder);
  if (!name || !match) {
    return '❌ Usage: `!setlist move <name> <songTitle> <position>`';
  }

  const title = match[1].trim();
  const position = parsePosition(match[2]);
  if (position === null) {
    return `❌ Invalid position "${match[2]}". Use a positive whole number, e.g. \`!setlist move ${name} ${title} 1\`.`;
  }

  const setlist = await getSetlistByName(name);
  if (!setlist) return `❌ No setlist found named "${name}".`;

  const song = await getSongByTitle(title);
  if (!song) return `❌ No song found named "${title}".`;

  const moved = await moveSetlistSong(setlist.id, song.id, position);
  if (!moved) return `❌ "${song.title}" is not on *${setlist.name}*.`;

  return `✅ Moved ${formatSongLine(song)} to position ${position} on *${setlist.name}*.`;
}

async function handleDelete(name: string): Promise<string> {
  if (!name) return '❌ Usage: `!setlist delete <name>`';

  const setlist = await getSetlistByName(name);
  if (!setlist) return `❌ No setlist found named "${name}".`;

  await deleteSetlist(setlist.id);
  return `🗑️ Deleted setlist "${setlist.name}".`;
}
