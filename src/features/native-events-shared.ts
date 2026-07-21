/**
 * Shared native-event plumbing used by both the !event command
 * (native-events.ts) and the !rehearsal ↔ native-event tie-in
 * (rehearsal-events.ts): the platform create/cancel calls, the
 * WhatsApp outbound-safety held-job semantics (the held job IS the
 * message — record intent immediately, never instruct re-running),
 * and the optional linked event_reminders row.
 */

import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import {
  addEventReminder,
  addNativeEvent,
  cancelEventReminder,
  updateNativeEvent as updateNativeEventRecord,
  type NativeEvent,
} from '../utils/db.js';
import type { NativeEventPayload, PlatformMessenger } from '../core/platform-messenger.js';

const REMINDER_MIN_DELAY_SECONDS = 60;
const ERROR_TEXT_MAX_CHARS = 200;

export interface TrackedEventContext {
  messenger: PlatformMessenger;
  chatId: string;
}

export interface NewTrackedEvent {
  name: string;
  description?: string;
  location?: string;
  startAtMs: number;
  endAtMs?: number;
  createdBy: string;
}

export interface CreateTrackedEventOptions {
  /**
   * Skip creating the linked event_reminders row. Used by the !rehearsal
   * tie-in: rehearsals have their OWN reminder poller
   * (listRehearsalsNeedingReminder), so a second event_reminders row for
   * the linked native event would double-ping the band.
   */
  skipReminder?: boolean;
}

export type CreateTrackedEventResult =
  | { outcome: 'created'; event: NativeEvent; heldJob: HeldJob | null }
  | { outcome: 'unsupported' }
  | { outcome: 'failed'; errorText: string };

/**
 * Create a native event on the platform and record it in native_events
 * (plus an optional linked reminder row). A WhatsApp outbound-safety hold
 * is NOT a failure: the event is recorded immediately with a held-job ref
 * and the caller's reply must name the job, never suggest re-running.
 */
export async function createTrackedNativeEvent(
  ctx: TrackedEventContext,
  input: NewTrackedEvent,
  opts: CreateTrackedEventOptions = {},
): Promise<CreateTrackedEventResult> {
  if (!ctx.messenger.createNativeEvent) return { outcome: 'unsupported' };

  const payload: NativeEventPayload = {
    name: input.name,
    description: input.description,
    startAtMs: input.startAtMs,
    endAtMs: input.endAtMs,
    location: input.location,
  };

  let platformRef: string;
  let heldJob: HeldJob | null = null;
  try {
    platformRef = await ctx.messenger.createNativeEvent(ctx.chatId, payload);
  } catch (err) {
    heldJob = asHeldJob(err);
    if (!heldJob) return { outcome: 'failed', errorText: describeSendError(err, 'create') };
    // The held job IS the event message: record the event now so it is
    // tracked; the message posts when the owner releases the job. A hold
    // without a job id can never be reconciled to the real message ref
    // later, so store the untracked-ref marker instead of {"heldJobId":null}.
    platformRef = JSON.stringify(
      heldJob.jobId === null ? { missingKey: true } : { heldJobId: heldJob.jobId },
    );
  }

  let event = await addNativeEvent({
    chatId: ctx.chatId,
    platform: ctx.messenger.platform,
    name: input.name,
    description: input.description ?? null,
    location: input.location ?? null,
    startAtMs: input.startAtMs,
    endAtMs: input.endAtMs ?? null,
    platformRef,
    createdBy: input.createdBy,
  });

  if (!opts.skipReminder) {
    const reminderId = await maybeAddReminderRow(event);
    if (reminderId !== null) {
      event = (await updateNativeEventRecord(event.id, { reminderId })) ?? event;
    }
  }

  return { outcome: 'created', event, heldJob };
}

export interface CancelTrackedEventOptions {
  /**
   * Soft-cancel the native_events row (and its reminder) even when the
   * platform cancel fails or is unsupported. Used by the !rehearsal
   * tie-in, where the rehearsal cancel must never be blocked by the
   * platform — the caller degrades to a warning line instead.
   */
  recordOnFailure?: boolean;
}

export type CancelTrackedEventResult =
  | { outcome: 'cancelled'; heldJob: HeldJob | null }
  | { outcome: 'unsupported' }
  | { outcome: 'failed'; errorText: string };

/**
 * Cancel a native event on the platform and soft-cancel its row plus the
 * linked reminder. A held cancellation message still cancels the event
 * here; the notice posts when the owner releases the job.
 */
export async function cancelTrackedNativeEvent(
  event: NativeEvent,
  ctx: TrackedEventContext,
  opts: CancelTrackedEventOptions = {},
): Promise<CancelTrackedEventResult> {
  if (!ctx.messenger.cancelNativeEvent) {
    if (opts.recordOnFailure) await recordCancelled(event);
    return { outcome: 'unsupported' };
  }

  let heldJob: HeldJob | null = null;
  try {
    await ctx.messenger.cancelNativeEvent(ctx.chatId, event.platformRef, toEventPayload(event));
  } catch (err) {
    heldJob = asHeldJob(err);
    if (!heldJob) {
      if (opts.recordOnFailure) await recordCancelled(event);
      return { outcome: 'failed', errorText: describeSendError(err, 'cancel') };
    }
    // Held cancellation message: the event is still cancelled here; the
    // notice posts when the owner releases the job.
  }

  await recordCancelled(event);
  return { outcome: 'cancelled', heldJob };
}

async function recordCancelled(event: NativeEvent): Promise<void> {
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
}

export function toEventPayload(
  event: Pick<NativeEvent, 'name' | 'description' | 'location' | 'startAtMs' | 'endAtMs'>,
): NativeEventPayload {
  return {
    name: event.name,
    description: event.description ?? undefined,
    startAtMs: event.startAtMs,
    endAtMs: event.endAtMs ?? undefined,
    location: event.location ?? undefined,
  };
}

export interface HeldJob {
  jobId: number | null;
}

/** Recognize the outbound-safety hold (queued for manual release, not a failure). */
export function asHeldJob(err: unknown): HeldJob | null {
  if (!(err instanceof Error) || err.name !== 'WhatsAppOutboundHeldError') return null;
  const jobId = (err as { jobId?: number }).jobId;
  return { jobId: typeof jobId === 'number' ? jobId : null };
}

/**
 * Reply for a held send. The held job is the message itself — the event or
 * change is already recorded, so the reply must never instruct re-running
 * the command (that would double-send on release).
 */
export function heldReply(what: string, recorded: string, jobId: number | null): string {
  const job = jobId === null ? '' : ` as job #${jobId}`;
  return `📨 The ${what} was queued by the WhatsApp safety layer${job} — ${recorded} is recorded and will post when you release it with \`!whatsapp release ${jobId ?? '<id>'}\`.`;
}

export function describeSendError(err: unknown, verb: string): string {
  const detail = err instanceof Error ? err.message : String(err);
  logger.warn({ err, verb }, 'Native event platform call failed');
  return `❌ Couldn't ${verb} the event: ${detail.slice(0, ERROR_TEXT_MAX_CHARS)}`;
}

/** Reminder times (epoch seconds): lead before start, clamped to now+60s. */
export function computeReminderTimes(startAtMs: number): { eventAt: number; remindAt: number } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const eventAt = Math.floor(startAtMs / 1000);
  let remindAt = eventAt - config.EVENT_REMINDER_LEAD_MINUTES * 60;
  if (remindAt <= nowSeconds) {
    remindAt = nowSeconds + REMINDER_MIN_DELAY_SECONDS;
  }
  return { eventAt, remindAt };
}

/** Create the linked reminder row; returns its id, or null when disabled/failed. */
export async function maybeAddReminderRow(event: NativeEvent): Promise<number | null> {
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
