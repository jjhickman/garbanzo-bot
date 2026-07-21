/**
 * Native platform events — real calendar entries, not just chat text.
 *
 * Owner/band commands:
 *   !event <when> | <name> [| location]  — create a native event
 *   !event list                          — upcoming events in this chat
 *   !event show <id>                     — event details
 *   !event move <id> <when>              — reschedule an event
 *   !event rename <id> <name>            — rename an event
 *   !event cancel <id>                   — cancel an event
 *
 * On Discord this manages guild scheduled events (needs the Manage Events
 * permission). On WhatsApp it sends native event messages; WhatsApp offers
 * no supported edit for event messages, so move/rename/cancel send a
 * corrected replacement event message and the stored ref tracks the latest
 * message key. When the WhatsApp outbound-safety layer holds a send, the
 * held job IS the event message: the DB records the event or change
 * immediately and the reply names the held job — never "run the command
 * again". Platforms without the capability get a "not supported" reply.
 *
 * The platform create/cancel + held-job + reminder plumbing lives in
 * native-events-shared.ts, shared with the !rehearsal tie-in.
 */

import { logger } from '../middleware/logger.js';
import {
  countNativeEventRsvps,
  getNativeEventById,
  listUpcomingNativeEvents,
  renameEventReminder,
  rescheduleEventReminder,
  supportsNativeEvents,
  updateNativeEvent as updateNativeEventRecord,
  type NativeEvent,
} from '../utils/db.js';
import { resolveEventTimestamp } from './event-time.js';
import {
  asHeldJob,
  cancelTrackedNativeEvent,
  computeReminderTimes,
  createTrackedNativeEvent,
  describeSendError,
  heldReply,
  maybeAddReminderRow,
  toEventPayload,
  type HeldJob,
} from './native-events-shared.js';
import type { PlatformMessenger } from '../core/platform-messenger.js';

// Discord caps scheduled-event names at 100 chars and description/location
// at 1000; WhatsApp gets the same bounds for cross-platform consistency.
const NAME_MAX_CHARS = 100;
const TEXT_FIELD_MAX_CHARS = 1000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface NativeEventContext {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
}

/**
 * Parse a free-form "when" (e.g. "tomorrow 7pm", "friday", "8/2 19:00")
 * into an epoch-ms timestamp via the shared event-time resolver. Returns
 * null for unparseable input, past times, or times over 30 days out.
 */
export function parseEventWhen(when: string, now: Date = new Date()): number | null {
  const trimmed = when.trim();
  if (!trimmed) return null;

  const timeMatch = trimmed.match(
    /\b(noon|at\s+\d{1,2}(?::\d{2})?|\d{1,2}:\d{2}|\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*$/i,
  );
  const timePart = timeMatch ? timeMatch[1] : null;
  const datePart = (timeMatch ? trimmed.slice(0, timeMatch.index).trim() : trimmed) || null;
  return resolveEventTimestamp(datePart, timePart, now);
}

export async function handleNativeEventCommand(args: string, ctx: NativeEventContext): Promise<string> {
  const trimmed = args.trim();
  if (!trimmed) return usage();

  if (!ctx.messenger.createNativeEvent) {
    return '📅 Native events are not supported on this platform yet.';
  }

  // Guard BEFORE any platform call: a backend without native-event
  // persistence would let the live platform event go out and then throw on
  // the row insert, orphaning a real event (no link, cancel can't sync it).
  if (!supportsNativeEvents()) {
    return '📅 Native events need the sqlite database backend — this database backend doesn\'t store them yet.';
  }

  if (trimmed.includes('|')) {
    return handleCreate(trimmed, ctx);
  }

  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'list':
      return handleList(ctx);
    case 'show':
      return handleShow(rest, ctx);
    case 'move':
      return handleMove(rest, ctx);
    case 'rename':
      return handleRename(rest, ctx);
    case 'cancel':
      return handleCancel(rest, ctx);
    default:
      return usage();
  }
}

function usage(): string {
  return [
    '📅 *Native Events*',
    '',
    'Commands:',
    '  `!event <when> | <name> [| location]` — create an event',
    '  `!event list` — upcoming events in this chat',
    '  `!event show <id>` — event details',
    '  `!event move <id> <when>` — reschedule an event',
    '  `!event rename <id> <name>` — rename an event',
    '  `!event cancel <id>` — cancel an event',
    '',
    'When: `tomorrow 7pm`, `friday 8pm`, `8/2 19:00` (within 30 days).',
  ].join('\n');
}

export function formatEventLine(event: NativeEvent): string {
  const parts = [`#${event.id}`, formatEventStart(event.startAtMs), event.name];
  if (event.location) parts.push(event.location);
  if (event.status !== 'scheduled') parts.push(event.status);
  return parts.join(' · ');
}

async function handleCreate(text: string, ctx: NativeEventContext): Promise<string> {
  const parts = text.split('|').map((part) => part.trim());
  const [whenText, name, location] = parts;
  if (parts.length < 2 || parts.length > 3 || !whenText || !name) {
    return '❌ Usage: `!event <when> | <name> [| location]`';
  }

  const invalid = validateEventText(name, location || undefined);
  if (invalid) return invalid;

  const startAtMs = parseEventWhen(whenText);
  if (startAtMs === null) {
    return `❌ I couldn't use "${whenText}" — give me a future time within 30 days, like \`tomorrow 7pm\` or \`friday 8pm\`.`;
  }

  const result = await createTrackedNativeEvent(
    { messenger: ctx.messenger, chatId: ctx.chatId },
    { name, location: location || undefined, startAtMs, createdBy: ctx.senderId },
  );
  if (result.outcome === 'unsupported') {
    return '📅 Native events are not supported on this platform yet.';
  }
  if (result.outcome === 'failed') return result.errorText;

  if (result.heldJob) {
    return heldReply('event message', `event ${formatEventLine(result.event)}`, result.heldJob.jobId);
  }
  return `✅ Created event ${formatEventLine(result.event)}`;
}

async function handleList(ctx: NativeEventContext): Promise<string> {
  const events = await listUpcomingNativeEvents(ctx.chatId, Date.now());
  if (events.length === 0) {
    return '📅 No upcoming events here. Create one: `!event <when> | <name> [| location]`';
  }

  const lines = [`📅 *Upcoming Events* (${events.length})`, ''];
  for (const event of events) lines.push(`  ${formatEventLine(event)}`);
  return lines.join('\n');
}

async function handleShow(idText: string, ctx: NativeEventContext): Promise<string> {
  const event = await findChatEvent(idText, ctx);
  if (typeof event === 'string') return event;

  const lines = [`📅 ${formatEventLine(event)}`];
  if (event.description) lines.push('', event.description);
  const rsvpLine = await buildNativeEventRsvpLine(event, ctx);
  if (rsvpLine) lines.push('', rsvpLine);
  return lines.join('\n');
}

/**
 * RSVP summary for `!event show` (and reused by `!rehearsal show` for a
 * linked event). WhatsApp counts come from ingested event responses
 * (`native_event_rsvps`) — counts only, never responder JIDs; there is no
 * clean display-name source and raw JIDs must never be rendered to the
 * group. Discord reports a live interested-user count over REST. Any
 * failure degrades to showing the event without counts.
 */
export async function buildNativeEventRsvpLine(
  event: NativeEvent,
  ctx: { messenger?: PlatformMessenger; chatId?: string },
): Promise<string | null> {
  if (event.platform === 'whatsapp') {
    try {
      const counts = await countNativeEventRsvps(event.id);
      return `🙋 Going ${counts.going} · Maybe ${counts.maybe} · Not going ${counts.notGoing}`;
    } catch (err) {
      logger.warn({ err, eventId: event.id }, 'Failed to read RSVP counts for native event');
      return null;
    }
  }

  if (!ctx.messenger?.getNativeEventInterestCount || !ctx.chatId) return null;
  try {
    const count = await ctx.messenger.getNativeEventInterestCount(ctx.chatId, event.platformRef);
    return count === null ? null : `🙋 Interested: ${count}`;
  } catch (err) {
    logger.warn({ err, eventId: event.id }, 'Failed to fetch interest count for native event');
    return null;
  }
}

async function handleMove(rest: string, ctx: NativeEventContext): Promise<string> {
  const spaceIdx = rest.indexOf(' ');
  const idText = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const whenText = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
  if (!idText || !whenText) return '❌ Usage: `!event move <id> <when>`';

  const event = await findMutableChatEvent(idText, ctx);
  if (typeof event === 'string') return event;

  const startAtMs = parseEventWhen(whenText);
  if (startAtMs === null) {
    return `❌ I couldn't use "${whenText}" — give me a future time within 30 days, like \`tomorrow 7pm\`.`;
  }

  return applyPlatformUpdate(event, { startAtMs }, ctx, 'move');
}

async function handleRename(rest: string, ctx: NativeEventContext): Promise<string> {
  const spaceIdx = rest.indexOf(' ');
  const idText = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const name = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
  if (!idText || !name) return '❌ Usage: `!event rename <id> <name>`';

  const invalid = validateEventText(name);
  if (invalid) return invalid;

  const event = await findMutableChatEvent(idText, ctx);
  if (typeof event === 'string') return event;

  return applyPlatformUpdate(event, { name }, ctx, 'rename');
}

async function handleCancel(idText: string, ctx: NativeEventContext): Promise<string> {
  const event = await findMutableChatEvent(idText, ctx);
  if (typeof event === 'string') return event;

  const result = await cancelTrackedNativeEvent(event, { messenger: ctx.messenger, chatId: ctx.chatId });
  if (result.outcome === 'unsupported') {
    return '📅 Cancelling native events is not supported on this platform yet.';
  }
  if (result.outcome === 'failed') return result.errorText;

  if (result.heldJob) {
    return heldReply('cancellation message', `the cancellation of event #${event.id} (${event.name})`, result.heldJob.jobId);
  }
  return `🗑️ Cancelled event #${event.id} (${event.name}).`;
}

async function applyPlatformUpdate(
  event: NativeEvent,
  patch: Partial<{ name: string; startAtMs: number }>,
  ctx: NativeEventContext,
  verb: 'move' | 'rename',
): Promise<string> {
  if (!ctx.messenger.updateNativeEvent) {
    return '📅 Updating native events is not supported on this platform yet.';
  }

  const payload = toEventPayload({ ...event, ...patch });
  let platformRef = event.platformRef;
  let heldJob: HeldJob | null = null;
  try {
    platformRef = await ctx.messenger.updateNativeEvent(ctx.chatId, event.platformRef, payload);
  } catch (err) {
    heldJob = asHeldJob(err);
    if (!heldJob) return describeSendError(err, verb);
    // Held replacement send: the DB update still applies now, and the
    // prior ref stays (WhatsApp ignores refs for replacement sends).
  }

  let updated = await updateNativeEventRecord(event.id, { ...patch, platformRef });
  if (!updated) return `❌ No event found with id #${event.id}.`;
  updated = await syncReminder(updated, patch);

  if (heldJob) {
    return heldReply('updated event message', `the change to event #${event.id}`, heldJob.jobId);
  }
  return `✅ Updated: ${formatEventLine(updated)}`;
}

/**
 * Keep the linked event_reminders row in step with a move/rename. A move
 * reschedules the still-pending reminder in place; if the reminder already
 * fired (or was cancelled), a fresh pending row is created for the new time
 * and linked. A rename updates the reminder's activity text.
 */
async function syncReminder(
  event: NativeEvent,
  patch: Partial<{ name: string; startAtMs: number }>,
): Promise<NativeEvent> {
  if (event.reminderId === null) return event;

  try {
    if (patch.startAtMs !== undefined) {
      const { eventAt, remindAt } = computeReminderTimes(event.startAtMs);
      const rescheduled = await rescheduleEventReminder(event.reminderId, eventAt, remindAt);
      if (!rescheduled) {
        const reminderId = await maybeAddReminderRow(event);
        return (await updateNativeEventRecord(event.id, { reminderId })) ?? event;
      }
    }
    if (patch.name !== undefined) {
      await renameEventReminder(event.reminderId, patch.name);
    }
  } catch (err) {
    logger.warn({ err, eventId: event.id, reminderId: event.reminderId }, 'Failed to sync reminder for native event');
  }
  return event;
}

async function findChatEvent(idText: string, ctx: NativeEventContext): Promise<NativeEvent | string> {
  const id = parseEventId(idText);
  if (id === null) return '❌ Give me an event id, e.g. `!event show 3`.';

  const event = await getNativeEventById(id);
  if (!event || event.chatId !== ctx.chatId || event.platform !== ctx.messenger.platform) {
    return `❌ No event found with id #${id} in this chat.`;
  }
  return event;
}

async function findMutableChatEvent(idText: string, ctx: NativeEventContext): Promise<NativeEvent | string> {
  const event = await findChatEvent(idText, ctx);
  if (typeof event === 'string') return event;
  if (event.status !== 'scheduled') return `❌ Event #${event.id} is already cancelled.`;
  if (event.startAtMs <= Date.now()) return `❌ Event #${event.id} already happened.`;
  return event;
}

function parseEventId(value: string): number | null {
  const id = Number(value.trim().replace(/^#/, ''));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Pre-validate user-provided text against the platform limits. */
function validateEventText(name: string, location?: string): string | null {
  if (name.length > NAME_MAX_CHARS) {
    return `❌ Event names are limited to ${NAME_MAX_CHARS} characters — yours is ${name.length}. Try a shorter name.`;
  }
  if (location !== undefined && location.length > TEXT_FIELD_MAX_CHARS) {
    return `❌ Event locations are limited to ${TEXT_FIELD_MAX_CHARS} characters — yours is ${location.length}. Try a shorter location.`;
  }
  return null;
}

function formatEventStart(startAtMs: number): string {
  const date = new Date(startAtMs);
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()} ${formatTime(date)}`;
}

function formatTime(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')}${suffix}`;
}
