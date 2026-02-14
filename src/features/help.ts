import { bold } from '../utils/formatting.js';

/**
 * Help command — shows users what Garbanzo can do.
 */

export function getHelpMessage(): string {
  return [
    `${bold('Hey, I\'m Garbanzo Bean!')} 🫘`,
    'Your Boston community bot. Here\'s what I can do:',
    '',
    `${bold('Weather')}`,
    '  "weather" — current conditions in Boston',
    '  "forecast" — 5-day forecast',
    '  "weather in [city]" — weather elsewhere',
    '',
    `${bold('MBTA Transit')}`,
    '  "red line status" — service alerts',
    '  "next train at [station]" — live arrivals',
    '  "schedule at [station]" — upcoming departures',
    '',
    `${bold('News')}`,
    '  "news" — top US headlines',
    '  "news about [topic]" — search for articles',
    '',
    `${bold('Anything Else')}`,
    '  Just ask! I can answer questions, give Boston',
    '  recs, or chat about whatever.',
    '',
    '_@mention me in any group to get started._',
  ].join('\n');
}
