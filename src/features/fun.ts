/**
 * Fun features — trivia, fun facts, today in history, icebreakers.
 *
 * APIs (all free, no keys):
 * - Open Trivia DB (opentdb.com) — trivia questions
 * - Useless Facts API (uselessfacts.jsph.pl) — random fun facts
 * - Muffin Labs History API (history.muffinlabs.com) — this day in history
 * - Curated icebreaker list — local, no API
 *
 * Commands:
 *   !trivia              — random trivia question
 *   !trivia science      — category-specific
 *   !fact                — random fun fact
 *   !today               — this day in history
 *   !icebreaker          — conversation starter
 */

import { logger } from '../middleware/logger.js';
import { bold } from '../utils/formatting.js';

const TIMEOUT_MS = 8_000;

// ── Open Trivia DB ──────────────────────────────────────────────────

export const TRIVIA_CATEGORIES: Record<string, number> = {
  general: 9,
  books: 10, literature: 10,
  film: 11, movies: 11,
  music: 12,
  tv: 14, television: 14,
  games: 15, videogames: 15,
  science: 17,
  computers: 18, tech: 18,
  math: 19,
  mythology: 20,
  sports: 21,
  geography: 22,
  history: 23,
  politics: 24,
  art: 25,
  animals: 27,
  comics: 29,
  anime: 31,
};

interface TriviaQuestion {
  category: string;
  difficulty: string;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

export function decodeHTML(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&eacute;/g, 'é')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü');
}

async function fetchTrivia(category?: string): Promise<string> {
  let url = 'https://opentdb.com/api.php?amount=1&type=multiple';

  if (category) {
    const catId = TRIVIA_CATEGORIES[category.toLowerCase()];
    if (catId) url += `&category=${catId}`;
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return '🧠 Trivia API is having issues. Try again in a moment.';

    const data = await response.json() as { response_code: number; results: TriviaQuestion[] };
    if (data.response_code !== 0 || !data.results.length) {
      return '🧠 No trivia questions available right now. Try a different category.';
    }

    const q = data.results[0];
    const question = decodeHTML(q.question);
    const correct = decodeHTML(q.correct_answer);
    const incorrect = q.incorrect_answers.map(decodeHTML);

    // Shuffle options
    const options = [...incorrect, correct].sort(() => Math.random() - 0.5);
    const correctIndex = options.indexOf(correct);
    const letters = ['A', 'B', 'C', 'D'];

    const lines: string[] = [
      `🧠 ${bold('Trivia')} — _${decodeHTML(q.category)}_ (${q.difficulty})`,
      '',
      question,
      '',
    ];

    for (let i = 0; i < options.length; i++) {
      lines.push(`  ${bold(letters[i])}. ${options[i]}`);
    }

    lines.push('');
    lines.push(`||Answer: ${letters[correctIndex]}. ${correct}||`);

    return lines.join('\n');
  } catch (err) {
    logger.error({ err }, 'Trivia fetch failed');
    return '🧠 Couldn\'t fetch trivia right now. Try again later.';
  }
}

// ── Useless Facts API ───────────────────────────────────────────────

async function fetchFunFact(): Promise<string> {
  try {
    const response = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return '💡 Fun fact API is down. Try again later.';

    const data = await response.json() as { text: string };
    return `💡 ${bold('Fun Fact')}\n\n${data.text}`;
  } catch (err) {
    logger.error({ err }, 'Fun fact fetch failed');
    return '💡 Couldn\'t fetch a fun fact right now.';
  }
}

// ── Muffin Labs History API ─────────────────────────────────────────

interface HistoryEvent {
  year: string;
  text: string;
}

async function fetchToday(): Promise<string> {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  try {
    const response = await fetch(`https://history.muffinlabs.com/date/${month}/${day}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return '📅 History API is down. Try again later.';

    const data = await response.json() as {
      date: string;
      data: { Events: HistoryEvent[]; Births: HistoryEvent[]; Deaths: HistoryEvent[] };
    };

    // Pick 3 random events
    const events = data.data.Events;
    const selected: HistoryEvent[] = [];
    const indices = new Set<number>();
    const count = Math.min(3, events.length);

    while (selected.length < count) {
      const idx = Math.floor(Math.random() * events.length);
      if (!indices.has(idx)) {
        indices.add(idx);
        selected.push(events[idx]);
      }
    }

    // Sort by year
    selected.sort((a, b) => Number(a.year) - Number(b.year));

    const lines: string[] = [
      `📅 ${bold(`This Day in History — ${data.date}`)}`,
      '',
    ];

    for (const event of selected) {
      lines.push(`• ${bold(event.year)} — ${event.text.slice(0, 300)}`);
    }

    // Pick one notable birth
    if (data.data.Births.length > 0) {
      const birth = data.data.Births[Math.floor(Math.random() * data.data.Births.length)];
      lines.push('');
      lines.push(`🎂 Born today: ${bold(birth.year)} — ${birth.text.slice(0, 200)}`);
    }

    return lines.join('\n');
  } catch (err) {
    logger.error({ err }, 'History API fetch failed');
    return '📅 Couldn\'t fetch today\'s history. Try again later.';
  }
}

// ── Icebreakers (curated, local) ────────────────────────────────────

export const ICEBREAKERS: string[] = [
  "What's the best meal you've had in Boston?",
  "If you could only eat at one restaurant for a year, where would it be?",
  "What's your unpopular opinion about the T?",
  "What neighborhood in Boston is underrated?",
  "If you could add one thing to Boston, what would it be?",
  "What's your go-to weekend activity?",
  "Coffee or tea, and where do you get it?",
  "What's the best concert venue in the area?",
  "If you weren't living in Boston, where would you be?",
  "What's your comfort food?",
  "Early bird or night owl?",
  "What's the last great book you read?",
  "If you could instantly learn one skill, what would it be?",
  "What's your hot take on clam chowder?",
  "Beach day or mountain hike?",
  "What's a hobby you've been meaning to start?",
  "What's the weirdest thing you've seen on the T?",
  "If you could teleport anywhere for dinner tonight, where?",
  "What song is stuck in your head right now?",
  "What's a hill you'll die on?",
  "Dunkin' or indie coffee shop?",
  "What's your favorite season in New England?",
  "What would you rename Boston to?",
  "What's the most overrated tourist spot here?",
  "If you hosted a group outing, what would we do?",
  "What was your first impression of Boston?",
  "What's the best pizza place in the area?",
  "If this group had a mascot, what would it be?",
  "What's something you're irrationally passionate about?",
  "What's your karaoke song?",
  "Fenway frank or North End cannoli?",
  "What's the best thing about this community?",
  "If you could have dinner with anyone (alive or dead), who?",
  "What's a local hidden gem most people don't know about?",
  "What board game would you play on a rainy day?",
  "What's the worst weather you've survived in Boston?",
  "Rooftop bar or dive bar?",
  "What would your D&D character class be in real life?",
  "If this group started a band, what would we be called?",
  "What's your go-to comfort show?",
];

function getIcebreaker(): string {
  const question = ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)];
  return `🧊 ${bold('Icebreaker')}\n\n${question}`;
}

// ── Public handler ──────────────────────────────────────────────────

export async function handleFun(subcommand: string): Promise<string> {
  const trimmed = subcommand.trim().toLowerCase();

  // Route by subcommand
  if (!trimmed || trimmed === 'help') return getFunHelp();

  if (trimmed === 'trivia' || trimmed.startsWith('trivia')) {
    const category = trimmed.replace(/^trivia\s*/, '').trim() || undefined;
    return await fetchTrivia(category);
  }

  if (trimmed === 'fact' || trimmed === 'funfact') {
    return await fetchFunFact();
  }

  if (trimmed === 'today' || trimmed === 'history') {
    return await fetchToday();
  }

  if (trimmed === 'icebreaker' || trimmed === 'ice') {
    return getIcebreaker();
  }

  // If a category name was given directly, try as trivia
  if (TRIVIA_CATEGORIES[trimmed]) {
    return await fetchTrivia(trimmed);
  }

  return getFunHelp();
}

function getFunHelp(): string {
  const categories = Object.keys(TRIVIA_CATEGORIES)
    .filter((k, i, arr) => arr.indexOf(k) === i) // unique
    .slice(0, 12)
    .join(', ');

  return [
    `🎉 ${bold('Fun Commands')}`,
    '',
    '  !trivia — random trivia question',
    '  !trivia [category] — by category',
    '  !fact — random fun fact',
    '  !today — this day in history',
    '  !icebreaker — conversation starter',
    '',
    `_Categories: ${categories}_`,
  ].join('\n');
}
