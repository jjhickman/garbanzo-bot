/**
 * Remy band practice tracking.
 *
 * Owner/band commands:
 *   !rehearsal schedule when=<date> [location=..] [agenda=..]  — add a rehearsal
 *   !rehearsal list                                            — list upcoming rehearsals
 *   !rehearsal show <id>                                       — show rehearsal details
 *   !rehearsal cancel <id>                                     — cancel a rehearsal
 *   !rehearsal note <id> <text>                                — replace agenda/notes
 *
 * Any band member command:
 *   !available <rehearsalId> yes|no|maybe                      — RSVP to a rehearsal
 *
 * Dates: YYYY-MM-DD HH:MM (24h) or YYYY-MM-DD (defaults to 7:00pm).
 */

import {
  addRehearsal,
  cancelRehearsal,
  getRehearsalById,
  listAvailability,
  listUpcomingRehearsals,
  setAvailability,
  updateRehearsal,
  type Availability,
  type AvailabilityResponse,
  type Rehearsal,
} from '../utils/db.js';
import { cancelRehearsalEvent, createRehearsalEvent, describeRehearsalEvent } from './rehearsal-events.js';
import { parseTitleAndFields } from './songs.js';
import type { PlatformMessenger } from '../core/platform-messenger.js';

const SCHEDULE_FIELDS = ['when', 'location', 'agenda'] as const;
const DATE_ONLY_DEFAULT_HOUR = 19;
const DATE_ONLY_DEFAULT_MINUTE = 0;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * messenger/chatId are optional: when present (group dispatch passes them),
 * schedule/cancel/show also manage a linked native platform event; when
 * absent, rehearsals behave exactly as before the tie-in existed.
 */
export interface RehearsalContext {
  senderId: string;
  messenger?: PlatformMessenger;
  chatId?: string;
}

export async function handleRehearsalCommand(args: string, ctx: RehearsalContext): Promise<string> {
  const trimmed = args.trim();
  if (!trimmed) return usage();

  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'schedule':
      return handleSchedule(rest, ctx);
    case 'list':
      return handleList();
    case 'show':
      return handleShow(rest, ctx);
    case 'cancel':
      return handleCancel(rest, ctx);
    case 'note':
      return handleNote(rest);
    default:
      return usage();
  }
}

export function formatRehearsalLine(rehearsal: Rehearsal): string {
  const parts = [`#${rehearsal.id}`, formatScheduledAt(rehearsal.scheduledAt)];
  if (rehearsal.location) parts.push(rehearsal.location);
  parts.push(rehearsal.status);
  return parts.join(' · ');
}

export function parseRehearsalWhen(value: string, now: Date = new Date()): number | null {
  const trimmed = value.trim();
  const relative = /^(today|tomorrow)(?:\s+(\d{2}):(\d{2}))?$/i.exec(trimmed);
  if (relative) {
    const dayOffset = relative[1].toLowerCase() === 'tomorrow' ? 1 : 0;
    const hour = relative[2] === undefined ? DATE_ONLY_DEFAULT_HOUR : Number(relative[2]);
    const minute = relative[3] === undefined ? DATE_ONLY_DEFAULT_MINUTE : Number(relative[3]);
    if (!isValidTime(hour, minute)) return null;

    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0);
    return Math.floor(date.getTime() / 1000);
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? DATE_ONLY_DEFAULT_HOUR : Number(match[4]);
  const minute = match[5] === undefined ? DATE_ONLY_DEFAULT_MINUTE : Number(match[5]);

  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || !Number.isInteger(hour)
    || !Number.isInteger(minute)
    || month < 1
    || month > 12
    || day < 1
    || day > 31
    || !isValidTime(hour, minute)
  ) {
    return null;
  }

  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) {
    return null;
  }

  return Math.floor(date.getTime() / 1000);
}

function isValidTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function usage(): string {
  return [
    '🎸 *Remy Rehearsals*',
    '',
    'Commands:',
    '  `!rehearsal schedule when=YYYY-MM-DD HH:MM [location=..] [agenda=..]` — add a rehearsal',
    '  `!rehearsal list` — list upcoming rehearsals',
    '  `!rehearsal show <id>` — show rehearsal details',
    '  `!rehearsal cancel <id>` — cancel a rehearsal',
    '  `!rehearsal note <id> <text>` — update the agenda',
  ].join('\n');
}

async function handleSchedule(rest: string, ctx: RehearsalContext): Promise<string> {
  const { fields } = parseTitleAndFields(rest, SCHEDULE_FIELDS);
  if (!fields.when) {
    return '❌ Usage: `!rehearsal schedule when=YYYY-MM-DD HH:MM [location=..] [agenda=..]`';
  }

  const scheduledAt = parseRehearsalWhen(fields.when);
  if (scheduledAt === null) {
    return `❌ I couldn't parse "${fields.when}". Use \`when=YYYY-MM-DD HH:MM\` or \`when=YYYY-MM-DD\`.`;
  }

  const rehearsal = await addRehearsal({
    scheduledAt,
    location: fields.location || undefined,
    agenda: fields.agenda || undefined,
    createdBy: ctx.senderId,
  });

  // Also create a native platform event where supported; the rehearsal is
  // already saved, so any tie-in outcome only appends a line to the reply.
  const eventLine = await createRehearsalEvent(rehearsal, ctx);
  const added = `✅ Added: ${formatRehearsalLine(rehearsal)}`;
  return eventLine ? `${added}\n${eventLine}` : added;
}

async function handleList(): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rehearsals = await listUpcomingRehearsals(nowSeconds);
  if (rehearsals.length === 0) {
    return '🎸 No upcoming rehearsals. Add one: `!rehearsal schedule when=YYYY-MM-DD HH:MM`';
  }

  const lines = [`🎸 *Upcoming Rehearsals* (${rehearsals.length})`, ''];
  for (const rehearsal of rehearsals) lines.push(`  ${formatRehearsalLine(rehearsal)}`);
  return lines.join('\n');
}

async function handleShow(idText: string, ctx: RehearsalContext): Promise<string> {
  const id = parseRehearsalId(idText);
  if (id === null) return '❌ Usage: `!rehearsal show <id>`';

  const rehearsal = await getRehearsalById(id);
  if (!rehearsal) return `❌ No rehearsal found with id #${id}.`;

  const lines = [`🎸 ${formatRehearsalLine(rehearsal)}`];
  if (rehearsal.agenda) lines.push('', rehearsal.agenda);

  const availability = await listAvailability(id);
  const summary = formatAvailabilitySummary(availability);
  if (summary) lines.push('', summary);

  const eventLines = await describeRehearsalEvent(rehearsal, ctx);
  if (eventLines.length > 0) lines.push('', ...eventLines);

  return lines.join('\n');
}

function formatAvailabilitySummary(responses: Availability[]): string | null {
  if (responses.length === 0) return null;

  const namesFor = (response: AvailabilityResponse): string[] =>
    responses
      .filter((entry) => entry.response === response)
      .map((entry) => entry.memberName ?? entry.memberId);

  const groups: Array<[string, string[]]> = [
    ['Coming', namesFor('yes')],
    ['Out', namesFor('no')],
    ['Maybe', namesFor('maybe')],
  ];

  const parts = groups
    .filter(([, names]) => names.length > 0)
    .map(([label, names]) => `${label}: ${names.join(', ')}`);

  return parts.length > 0 ? parts.join(' · ') : null;
}

async function handleCancel(idText: string, ctx: RehearsalContext): Promise<string> {
  const id = parseRehearsalId(idText);
  if (id === null) return '❌ Usage: `!rehearsal cancel <id>`';

  const cancelled = await cancelRehearsal(id);
  if (!cancelled) return `❌ No rehearsal found with id #${id}.`;

  // Sync the linked native platform event (soft-cancelled row, never
  // hard-deleted). Read the row back after the cancel: the rehearsal is
  // already cancelled, so the tie-in only appends a line to the reply.
  const reply = `🗑️ Cancelled rehearsal #${id}.`;
  const rehearsal = await getRehearsalById(id);
  const eventLine = rehearsal ? await cancelRehearsalEvent(rehearsal, ctx) : null;
  return eventLine ? `${reply}\n${eventLine}` : reply;
}

async function handleNote(rest: string): Promise<string> {
  const spaceIdx = rest.trim().indexOf(' ');
  const idText = spaceIdx === -1 ? rest.trim() : rest.trim().slice(0, spaceIdx);
  const agenda = spaceIdx === -1 ? '' : rest.trim().slice(spaceIdx + 1).trim();
  const id = parseRehearsalId(idText);
  if (id === null || !agenda) return '❌ Usage: `!rehearsal note <id> <text>`';

  const updated = await updateRehearsal(id, { agenda });
  if (!updated) return `❌ No rehearsal found with id #${id}.`;

  return [`✅ Updated: ${formatRehearsalLine(updated)}`, '', agenda].join('\n');
}

export async function handleAvailabilityCommand(
  args: string,
  ctx: { senderId: string; senderName?: string },
): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return availabilityUsage();

  const id = parseRehearsalId(parts[0]);
  const response = parseAvailabilityResponse(parts[1]);
  if (id === null || response === null) return availabilityUsage();

  const rehearsal = await getRehearsalById(id);
  if (!rehearsal) return `❌ No rehearsal found with id #${id}.`;

  if (rehearsal.status !== 'scheduled') {
    return `❌ Rehearsal #${id} is ${rehearsal.status}, so there's nothing to RSVP to.`;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (rehearsal.scheduledAt <= nowSeconds) {
    return `❌ Rehearsal #${id} already happened.`;
  }

  await setAvailability(id, ctx.senderId, ctx.senderName ?? null, response);
  return `✅ Got it — you're down as *${response}* for ${formatRehearsalLine(rehearsal)}`;
}

function parseAvailabilityResponse(value: string): AvailabilityResponse | null {
  const normalized = value.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'no' || normalized === 'maybe' ? normalized : null;
}

function availabilityUsage(): string {
  return '❌ Usage: `!available <rehearsalId> <yes|no|maybe>`';
}

function parseRehearsalId(value: string): number | null {
  const id = Number(value.trim().replace(/^#/, ''));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function formatScheduledAt(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()} ${formatTime(date)}`;
}

function formatTime(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')}${suffix}`;
}
