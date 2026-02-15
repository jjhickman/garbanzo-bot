import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { bold } from '../utils/formatting.js';
import { GROUP_IDS } from '../bot/groups.js';
import { handleWeather } from './weather.js';
import { handleTransit } from './transit.js';
import { getAIResponse } from '../ai/router.js';

/**
 * Event detection and enrichment — detects event proposals in chat
 * and enriches them with weather, transit, and AI-generated logistics.
 *
 * Passive in the Events group (no @mention needed).
 * In other groups, only triggers when @mentioned with an event query.
 */

// ── Constants ───────────────────────────────────────────────────────

/** Minimum text length to consider for event detection (avoid false positives on short msgs) */
const MIN_EVENT_TEXT_LENGTH = 15;

// ── Events group JID ────────────────────────────────────────────────

function getEventsJid(): string | null {
  for (const [jid, cfg] of Object.entries(GROUP_IDS)) {
    if (cfg.name === 'Events' && cfg.enabled) {
      return jid;
    }
  }
  return null;
}

export const EVENTS_JID = getEventsJid();

// ── Event detection patterns ────────────────────────────────────────
// Adapted from archive/openclaw/hooks/whatsapp-event-enrichment.js

/** Patterns that indicate someone is proposing or discussing an event */
const EVENT_PATTERNS: RegExp[] = [
  // "let's do/have/plan/go to X on Friday"
  /(?:let'?s|should we|want to|wanna|planning|organizing)\s+(?:do|have|plan|go(?:\s+to)?|attend|hit up|check out)\s+.+?(?:\s+(?:on|this|next|tonight|tomorrow|friday|saturday|sunday|monday|tuesday|wednesday|thursday))/i,

  // "anyone interested/down for X?"
  /anyone\s+(?:interested|down|want|wanna|dtf|keen)\s+(?:in|for|to)\s+.{5,}/i,

  // "who wants to go to X?"
  /who(?:'s|\s+is|\s+wants?)\s+(?:to|down|in)\s+(?:for\s+)?(?:go(?:ing)?(?:\s+to)?|come|join)\s+.{5,}/i,

  // Direct activity + time: "trivia tonight", "dinner at 7"
  /\b(trivia|karaoke|bar\s+crawl|drinks|happy\s+hour|dinner|brunch|lunch|coffee|game\s+night|board\s+games|movie|concert|show|comedy|open\s+mic|potluck|bbq|cookout|picnic|hike|hiking|kickball|volleyball|bowling|darts|pool|pub\s+quiz|escape\s+room|paint\s+night|yoga|run|5k|workout)\b.{0,30}\b(tonight|tomorrow|today|this|next|at\s+\d|on\s+\w+day|\d{1,2}\s*(am|pm))\b/i,

  // Time/day + activity: "Saturday night let's do trivia"
  /\b(tonight|tomorrow|this|next)\s+\w+day?\b.{0,40}\b(trivia|karaoke|bar\s+crawl|drinks|happy\s+hour|dinner|brunch|lunch|coffee|game\s+night|board\s+games|movie|concert|show|comedy|hike|bowling|escape\s+room)\b/i,

  // "event at/on" — explicit event word
  /\bevent\s+(?:at|on|this|next|tomorrow|tonight)\b/i,

  // "meetup at/on" — explicit meetup word
  /\bmeetup\s+(?:at|on|this|next|tomorrow|tonight)\b/i,

  // "gathering at" pattern
  /\bgathering\s+(?:at|on|this|next)\b/i,
];

// ── Date/time extraction ────────────────────────────────────────────

interface EventDetails {
  /** Raw activity/event description extracted from the message */
  activity: string;
  /** Date string if detected (e.g. "this Saturday", "tomorrow", "Feb 15") */
  date: string | null;
  /** Time string if detected (e.g. "7pm", "at 8", "evening") */
  time: string | null;
  /** Location/venue if mentioned */
  location: string | null;
  /** The full original message */
  rawText: string;
}

const DATE_PATTERNS: { pattern: RegExp; extract: (m: RegExpMatchArray) => string }[] = [
  { pattern: /(tonight|tomorrow|today)/i, extract: (m) => m[1] },
  { pattern: /(this|next)\s+(friday|saturday|sunday|monday|tuesday|wednesday|thursday|weekend)/i, extract: (m) => `${m[1]} ${m[2]}` },
  { pattern: /(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\s+(night|afternoon|evening|morning)/i, extract: (m) => `${m[1]} ${m[2]}` },
  { pattern: /\b(\d{1,2})\/(\d{1,2})\b/, extract: (m) => `${m[1]}/${m[2]}` },
  { pattern: /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})/i, extract: (m) => `${m[1]} ${m[2]}` },
  // Standalone day names
  { pattern: /\b(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/i, extract: (m) => m[1] },
];

const TIME_PATTERNS: { pattern: RegExp; extract: (m: RegExpMatchArray) => string }[] = [
  { pattern: /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i, extract: (m) => `${m[1]}${m[2] ? ':' + m[2] : ''}${m[3]}` },
  { pattern: /at\s+(\d{1,2})(?::(\d{2}))?(?!\s*(?:am|pm))/i, extract: (m) => `at ${m[1]}${m[2] ? ':' + m[2] : ''}` },
  { pattern: /\b(afternoon|morning|evening|night)\b/i, extract: (m) => m[1] },
];

/** Common venue/location patterns */
const LOCATION_PATTERNS: { pattern: RegExp; extract: (m: RegExpMatchArray) => string }[] = [
  { pattern: /\bat\s+(?:the\s+)?([A-Z][A-Za-z'']+(?:\s+[A-Z][A-Za-z'']+){0,4})/u, extract: (m) => m[1] },
  { pattern: /\b(?:at|@)\s+([A-Za-z'']+(?:\s+[A-Za-z'']+){0,3})/u, extract: (m) => m[1] },
];

/** Activity type normalization */
const ACTIVITY_ALIASES: Record<string, string> = {
  'trivia': 'trivia night',
  'karaoke': 'karaoke night',
  'bar crawl': 'bar crawl',
  'drinks': 'drinks',
  'happy hour': 'happy hour',
  'dinner': 'dinner',
  'brunch': 'brunch',
  'lunch': 'lunch',
  'coffee': 'coffee meetup',
  'game night': 'game night',
  'board games': 'game night',
  'movie': 'movie',
  'concert': 'concert',
  'show': 'show',
  'comedy': 'comedy show',
  'open mic': 'open mic night',
  'potluck': 'potluck',
  'bbq': 'BBQ',
  'cookout': 'cookout',
  'picnic': 'picnic',
  'hike': 'hike',
  'hiking': 'hike',
  'kickball': 'kickball',
  'volleyball': 'volleyball',
  'bowling': 'bowling',
  'darts': 'darts',
  'pool': 'pool night',
  'pub quiz': 'pub quiz',
  'escape room': 'escape room',
  'paint night': 'paint night',
  'yoga': 'yoga',
  'run': 'group run',
  '5k': '5K run',
  'workout': 'group workout',
};

// ── Detection ───────────────────────────────────────────────────────

/**
 * Detect if a message is proposing an event.
 * Returns EventDetails if detected, null otherwise.
 */
export function detectEvent(text: string): EventDetails | null {
  if (text.trim().length < MIN_EVENT_TEXT_LENGTH) return null;

  // Check if any event pattern matches
  let matched = false;
  for (const pattern of EVENT_PATTERNS) {
    if (pattern.test(text)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;

  // Extract details
  const date = extractFirst(text, DATE_PATTERNS);
  const time = extractFirst(text, TIME_PATTERNS);
  const location = extractFirst(text, LOCATION_PATTERNS);
  const activity = detectActivity(text);

  return {
    activity: activity ?? 'event',
    date,
    time,
    location,
    rawText: text,
  };
}

function extractFirst(
  text: string,
  patterns: { pattern: RegExp; extract: (m: RegExpMatchArray) => string }[],
): string | null {
  for (const { pattern, extract } of patterns) {
    const match = text.match(pattern);
    if (match) return extract(match);
  }
  return null;
}

function detectActivity(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [keyword, normalized] of Object.entries(ACTIVITY_ALIASES)) {
    if (lower.includes(keyword)) return normalized;
  }
  return null;
}

// ── Enrichment ──────────────────────────────────────────────────────

/**
 * Build an enriched response for a detected event.
 * Composes weather forecast, transit info, and an AI-generated summary.
 */
export async function enrichEvent(
  event: EventDetails,
  senderJid: string,
  groupJid: string,
): Promise<string> {
  const parts: string[] = [];

  // Header
  const activityLabel = bold(event.activity.charAt(0).toUpperCase() + event.activity.slice(1));
  const whenParts = [event.date, event.time].filter(Boolean);
  const when = whenParts.length > 0 ? whenParts.join(' ') : null;
  const where = event.location;

  parts.push(`🫘 Sounds like a plan! Here's what I found for ${activityLabel}${when ? ` (${when})` : ''}:`);
  parts.push('');

  // Weather enrichment
  const weatherQuery = buildWeatherQuery(event);
  if (weatherQuery && config.GOOGLE_API_KEY) {
    try {
      const weather = await handleWeather(weatherQuery);
      // Extract just the key info (first 3 lines of weather response)
      const weatherLines = weather.split('\n').filter((l) => l.trim()).slice(0, 3);
      parts.push(`${bold('Weather')}: ${weatherLines.join(' | ')}`);
    } catch (err) {
      logger.warn({ err, weatherQuery, groupJid, senderJid }, 'Weather enrichment failed for event');
    }
  }

  // Transit enrichment
  if (where && config.MBTA_API_KEY) {
    try {
      const transit = await handleTransit(`transit to ${where}`);
      // Just grab the alert summary if any
      const transitLines = transit.split('\n').filter((l) => l.trim()).slice(0, 3);
      parts.push(`${bold('Transit')}: ${transitLines.join(' | ')}`);
    } catch (err) {
      logger.warn({ err, where, groupJid, senderJid }, 'Transit enrichment failed for event');
    }
  }

  // AI summary — logistics tips, suggestions, vibe check
  const aiPrompt = buildEventAIPrompt(event);
  try {
    const aiResponse = await getAIResponse(aiPrompt, {
      groupName: 'Events',
      groupJid,
      senderJid,
    });
    if (aiResponse) {
      parts.push('');
      parts.push(aiResponse);
    }
  } catch (err) {
    logger.warn({ err, groupJid, senderJid }, 'AI enrichment failed for event');
  }

  return parts.join('\n');
}

function buildWeatherQuery(event: EventDetails): string | null {
  if (!event.date && !event.time) return null;
  const location = event.location ?? 'Boston';
  if (event.date) {
    return `weather forecast ${event.date} in ${location}`;
  }
  return `weather in ${location}`;
}

function buildEventAIPrompt(event: EventDetails): string {
  const parts = [`Someone proposed: "${event.rawText}"`];
  parts.push('');
  parts.push('Give a brief, helpful response (2-3 sentences max) with:');
  parts.push('- A quick logistics tip or suggestion relevant to this activity in Boston');
  if (event.location) {
    parts.push(`- Any useful info about ${event.location} (if you know it)`);
  }
  parts.push('- Keep it casual and encouraging — help build excitement');
  parts.push('');
  parts.push('Do NOT repeat the weather or transit info (that is shown separately).');
  parts.push('Do NOT ask questions. Just offer helpful tips.');
  return parts.join('\n');
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Handle an event-related @mention query. Used when someone @mentions
 * the bot in a non-Events group with an event-like message.
 */
export async function handleEvent(
  query: string,
  senderJid: string,
  groupJid: string,
): Promise<string | null> {
  const event = detectEvent(query);
  if (!event) return null;

  logger.info({ activity: event.activity, date: event.date, time: event.time, location: event.location }, 'Event detected via @mention');
  return await enrichEvent(event, senderJid, groupJid);
}

/**
 * Handle a message in the Events group (passive detection, no @mention).
 * Returns enriched response if an event is detected, null otherwise.
 */
export async function handleEventPassive(
  text: string,
  senderJid: string,
  groupJid: string,
): Promise<string | null> {
  const event = detectEvent(text);
  if (!event) return null;

  logger.info({ activity: event.activity, date: event.date, time: event.time, location: event.location }, 'Event detected passively in Events group');
  return await enrichEvent(event, senderJid, groupJid);
}
