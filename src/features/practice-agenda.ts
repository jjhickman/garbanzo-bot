/**
 * Practice agenda — a pure, LLM-free summary of what's next for the band:
 * the next rehearsal, songs that need work, and the setlist to run.
 *
 * Deliberately number/db-based (no LLM call), mirroring `buildWeeklyRecap`:
 * the agenda must render even when every AI provider is down, and it costs
 * nothing to build.
 */

import { getNextRehearsal, getSetlistSongs, listSetlists, listSongs } from '../utils/db.js';
import { formatRehearsalLine } from './rehearsals.js';
import { formatSetlist } from './setlists.js';
import { formatSongLine } from './songs.js';

const MAX_NEEDS_WORK_SONGS = 15;
const EMPTY_AGENDA_MESSAGE = 'No practice items yet — add songs with !song and schedule with !rehearsal.';

/**
 * Build the practice agenda text: next rehearsal, songs needing work
 * (status `rough` or `idea`), and the setlist to run (the first one
 * returned by `listSetlists()` — when only one exists, that's the only
 * choice; when several exist, we just take the first rather than guessing
 * at "most recent" without a recency-ordered query).
 */
export async function buildPracticeAgenda(now: Date = new Date()): Promise<string> {
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const [nextRehearsal, roughSongs, ideaSongs, setlists] = await Promise.all([
    getNextRehearsal(nowSeconds),
    listSongs('rough'),
    listSongs('idea'),
    listSetlists(),
  ]);

  const needsWork = [...roughSongs, ...ideaSongs];
  const setlist = setlists[0];

  if (!nextRehearsal && needsWork.length === 0 && !setlist) {
    return EMPTY_AGENDA_MESSAGE;
  }

  const lines: string[] = [
    `Next rehearsal: ${nextRehearsal ? formatRehearsalLine(nextRehearsal) : 'none scheduled'}`,
  ];

  if (needsWork.length > 0) {
    lines.push('', 'Needs work:');
    for (const song of needsWork.slice(0, MAX_NEEDS_WORK_SONGS)) {
      lines.push(`  ${formatSongLine(song)}`);
    }
    const remaining = needsWork.length - MAX_NEEDS_WORK_SONGS;
    if (remaining > 0) lines.push(`…and ${remaining} more`);
  }

  if (setlist) {
    const entries = await getSetlistSongs(setlist.id);
    lines.push('', 'Set to run:', formatSetlist(setlist, entries));
  }

  return lines.join('\n');
}

/** `!agenda` command handler — returns the practice agenda text. */
export async function handleAgendaCommand(): Promise<string> {
  return buildPracticeAgenda();
}
