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
    '  !weather — current conditions in Boston',
    '  !weather [city] — weather elsewhere',
    '  !forecast — 5-day forecast',
    '',
    `${bold('MBTA Transit')}`,
    '  !transit — current service alerts',
    '  !transit [station] — live arrivals',
    '  !mbta red line — line status',
    '',
    `${bold('News')}`,
    '  !news — top US headlines',
    '  !news [topic] — search for articles',
    '',
    `${bold('Events')}`,
    '  !events [idea] — plan an outing',
    '',
    `${bold('Anything Else')}`,
    '  Just ask! I can answer questions, give Boston',
    '  recs, or chat about whatever.',
    '',
    '_You can also use natural language — "what\'s the weather?" works too._',
    '_@mention me in any group to get started._',
  ].join('\n');
}
