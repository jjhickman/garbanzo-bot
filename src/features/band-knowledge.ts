import { config } from '../utils/config.js';
import { listSongs } from '../utils/db.js';
import { truncate } from '../utils/formatting.js';
import { formatSongLine } from './songs.js';

const MAX_PROMPT_SONGS = 40;
const MAX_PROMPT_SONG_LINE_CHARS = 160;

export async function formatBandKnowledgeForPrompt(): Promise<string> {
  if (!config.BAND_FEATURES_ENABLED) return '';

  const songs = await listSongs();
  if (songs.length === 0) return '';

  const lines = [
    'Band songs you know:',
    ...songs
      .slice(0, MAX_PROMPT_SONGS)
      .map((song) => `- ${truncate(formatSongLine(song), MAX_PROMPT_SONG_LINE_CHARS)}`),
  ];

  const remaining = songs.length - MAX_PROMPT_SONGS;
  if (remaining > 0) {
    lines.push(`…and ${remaining} more`);
  }

  return lines.join('\n');
}
