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
 */

import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import {
  addEventReminder,
  addNativeEvent,
  cancelEventReminder,
  getNativeEventById,
  listUpcomingNativeEvents,
  renameEventReminder,
  rescheduleEventReminder,
  updateNativeEvent as updateNativeEventRecord,
  type NativeEvent,
} from '../utils/db.js';
import { resolveEventTimestamp } from './event-time.js';
import type { NativeEventPayload, PlatformMessenger } from '../core/platform-messenger.js';

const REMINDER_MIN_DELAY_SECONDS = 60;
const ERROR_TEXT_MAX_CHARS = 200;
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

  if (!ctx.messenger.createNativeEvent) {
    return '📅 Native events are not supported on this platform yet.';
  }

  const payload: NativeEventPayload = { name, startAtMs, location: location || undefined };
  let platformRef: string;
  let heldJob: HeldJob | null = null;
  try {
    platformRef = await ctx.messenger.createNativeEvent(ctx.chatId, payload);
  } catch (err) {
    heldJob = asHeldJob(err);
    if (!heldJob) return describeSendError(err, 'create');
    // The held job IS the event message: record the event now so it is
    // tracked; the message posts when the owner releases the job.
    platformRef = JSON.stringify({ heldJobId: heldJob.jobId });
  }

  let event = await addNativeEvent({
    chatId: ctx.chatId,
    platform: ctx.messenger.platform,
    name,
    description: null,
    location: location || null,
    startAtMs,
    endAtMs: null,
    platformRef,
    createdBy: ctx.senderId,
  });

  const reminderId = await maybeAddReminderRow(event);
  if (reminderId !== null) {
    event = (await updateNativeEventRecord(event.id, { reminderId })) ?? event;
  }

  if (heldJob) {
    return heldReply('event message', `event ${formatEventLine(event)}`, heldJob.jobId);
  }
  return `✅ Created event ${formatEventLine(event)}`;
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
  return lines.join('\n');
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

  if (!ctx.messenger.cancelNativeEvent) {
    return '📅 Cancelling native events is not supported on this platform yet.';
  }

  let heldJob: HeldJob | null = null;
  try {
    await ctx.messenger.cancelNativeEvent(ctx.chatId, event.platformRef, toPayload(event));
  } catch (err) {
    heldJob = asHeldJob(err);
    if (!heldJob) return describeSendError(err, 'cancel');
    // Held cancellation message: the event is still cancelled here; the
    // notice posts when the owner releases the job.
  }

  await updateNativeEventRecord(event.id, { status: 'cancelled' });
  if (event.reminderId !== null) {
    // 'cancelled' is terminal for the reminder pollers: their due queries
    // only select status = 'pending' rows, so this can never fire.
    try {
      await cancelEventReminder(event.reminderId);
    } catch (err) {
      logger.warn({ err, eventId: event.id, reminderId: event.reminderId }, 'Failed to cancel reminder for native event');
    }
  }

  if (heldJob) {
    return heldReply('cancellation message', `the cancellation of event #${event.id} (${event.name})`, heldJob.jobId);
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

  const payload = toPayload({ ...event, ...patch });
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

function toPayload(event: Pick<NativeEvent, 'name' | 'description' | 'location' | 'startAtMs' | 'endAtMs'>): NativeEventPayload {
  return {
    name: event.name,
    description: event.description ?? undefined,
    startAtMs: event.startAtMs,
    endAtMs: event.endAtMs ?? undefined,
    location: event.location ?? undefined,
  };
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

interface HeldJob {
  jobId: number | null;
}

/** Recognize the outbound-safety hold (queued for manual release, not a failure). */
function asHeldJob(err: unknown): HeldJob | null {
  if (!(err instanceof Error) || err.name !== 'WhatsAppOutboundHeldError') return null;
  const jobId = (err as { jobId?: number }).jobId;
  return { jobId: typeof jobId === 'number' ? jobId : null };
}

/**
 * Reply for a held send. The held job is the message itself — the event or
 * change is already recorded, so the reply must never instruct re-running
 * the command (that would double-send on release).
 */
function heldReply(what: string, recorded: string, jobId: number | null): string {
  const job = jobId === null ? '' : ` as job #${jobId}`;
  return `📨 The ${what} was queued by the WhatsApp safety layer${job} — ${recorded} is recorded and will post when you release it with \`!whatsapp release ${jobId ?? '<id>'}\`.`;
}

function describeSendError(err: unknown, verb: string): string {
  const detail = err instanceof Error ? err.message : String(err);
  logger.warn({ err, verb }, 'Native event platform call failed');
  return `❌ Couldn't ${verb} the event: ${detail.slice(0, ERROR_TEXT_MAX_CHARS)}`;
}

/** Reminder times (epoch seconds): lead before start, clamped to now+60s. */
function computeReminderTimes(startAtMs: number): { eventAt: number; remindAt: number } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const eventAt = Math.floor(startAtMs / 1000);
  let remindAt = eventAt - config.EVENT_REMINDER_LEAD_MINUTES * 60;
  if (remindAt <= nowSeconds) {
    remindAt = nowSeconds + REMINDER_MIN_DELAY_SECONDS;
  }
  return { eventAt, remindAt };
}

/** Create the linked reminder row; returns its id, or null when disabled/failed. */
async function maybeAddReminderRow(event: NativeEvent): Promise<number | null> {
  if (!config.EVENT_REMINDERS_ENABLED) return null;

  const { eventAt, remindAt } = computeReminderTimes(event.startAtMs);
  try {
    const reminder = await addEventReminder({
      chatJid: event.chatId,
      activity: event.name,
      location: event.location,
      eventAt,
      remindAt,
      createdBy: event.createdBy,
    });
    return reminder.id;
  } catch (err) {
    logger.warn({ err, eventId: event.id }, 'Failed to add reminder row for native event');
    return null;
  }
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
