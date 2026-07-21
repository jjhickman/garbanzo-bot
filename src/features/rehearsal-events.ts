/**
 * !rehearsal ↔ native-event tie-in.
 *
 * When band features are on and the platform has a native event primitive
 * (Discord scheduled events, WhatsApp event messages), scheduling a
 * rehearsal also creates a real platform event, cancel keeps it in sync,
 * and `!rehearsal show` surfaces its status (plus RSVP counts where the
 * platform provides them).
 *
 * Every function here degrades to a warning line (or silence) — the
 * rehearsal command must NEVER fail because of the event tie-in.
 *
 * IMPORTANT — no double reminders: the linked native event is created with
 * `skipReminder`, so it gets NO event_reminders row. Rehearsals already
 * have their own reminder poller (listRehearsalsNeedingReminder, driven by
 * REHEARSAL_REMINDER_LEAD_MINUTES); a second reminder row for the same
 * start time would double-ping the band.
 */

import { logger } from '../middleware/logger.js';
import { getNativeEventById, supportsNativeEvents, updateRehearsal, type Rehearsal } from '../utils/db.js';
import { buildNativeEventRsvpLine, formatEventLine } from './native-events.js';
import {
  cancelTrackedNativeEvent,
  createTrackedNativeEvent,
  heldReply,
} from './native-events-shared.js';
import type { PlatformMessenger } from '../core/platform-messenger.js';

/** Platform context for the tie-in; absent (e.g. in schedulers) → no-op. */
export interface RehearsalPlatformContext {
  senderId: string;
  messenger?: PlatformMessenger;
  chatId?: string;
}

const REHEARSAL_EVENT_NAME = 'Band rehearsal';
const DEFAULT_EVENT_DURATION_MS = 2 * 60 * 60 * 1000;
// Discord caps description/location at 1000 chars; clamp so an oversized
// agenda can never make the platform call fail.
const TEXT_FIELD_MAX_CHARS = 1000;

/**
 * Create the linked platform event for a freshly scheduled rehearsal and
 * store the link on the rehearsal row. Returns a reply line to append, or
 * null when the platform has no native-event capability (the rehearsal
 * then behaves exactly as before the tie-in existed).
 */
export async function createRehearsalEvent(
  rehearsal: Rehearsal,
  ctx: RehearsalPlatformContext,
): Promise<string | null> {
  if (!ctx.messenger?.createNativeEvent || !ctx.chatId) return null;
  // A backend that can't persist native events must not create a live
  // platform event: the create would succeed and the row insert would then
  // throw, leaving a real event with no link that cancel could never sync.
  // Behave exactly like the capability-absent path (pre-tie-in behavior).
  if (!supportsNativeEvents()) return null;

  try {
    const startAtMs = rehearsal.scheduledAt * 1000;
    const result = await createTrackedNativeEvent(
      { messenger: ctx.messenger, chatId: ctx.chatId },
      {
        name: REHEARSAL_EVENT_NAME,
        description: rehearsal.agenda?.slice(0, TEXT_FIELD_MAX_CHARS) ?? undefined,
        location: rehearsal.location?.slice(0, TEXT_FIELD_MAX_CHARS) ?? undefined,
        startAtMs,
        endAtMs: startAtMs + DEFAULT_EVENT_DURATION_MS,
        createdBy: ctx.senderId,
      },
      // No event_reminders row: rehearsals have their own reminder poller,
      // and a second reminder would double-ping the band (see file header).
      { skipReminder: true },
    );

    if (result.outcome === 'unsupported') return null;
    if (result.outcome === 'failed') {
      return '⚠️ The rehearsal is scheduled, but the platform event could not be created.';
    }

    await updateRehearsal(rehearsal.id, { nativeEventId: result.event.id });
    if (result.heldJob) {
      return heldReply('event message', `event ${formatEventLine(result.event)}`, result.heldJob.jobId);
    }
    return `📅 Platform event created: ${formatEventLine(result.event)}`;
  } catch (err) {
    logger.warn({ err, rehearsalId: rehearsal.id }, 'Rehearsal native-event tie-in failed on schedule');
    return '⚠️ The rehearsal is scheduled, but the platform event could not be created.';
  }
}

/**
 * Cancel the linked platform event for a cancelled rehearsal. The native
 * row (and any reminder) is soft-cancelled even when the platform call
 * fails — the rehearsal cancel must not be blocked; the caller just gets
 * a warning line instead.
 */
export async function cancelRehearsalEvent(
  rehearsal: Rehearsal,
  ctx: RehearsalPlatformContext,
): Promise<string | null> {
  if (rehearsal.nativeEventId === null) return null;

  try {
    const event = await getNativeEventById(rehearsal.nativeEventId);
    if (!event || event.status !== 'scheduled') return null;
    if (!ctx.messenger || !ctx.chatId) return null;

    const result = await cancelTrackedNativeEvent(
      event,
      { messenger: ctx.messenger, chatId: ctx.chatId },
      { recordOnFailure: true },
    );

    if (result.outcome === 'cancelled') {
      if (result.heldJob) {
        return heldReply('cancellation message', `the cancellation of event #${event.id} (${event.name})`, result.heldJob.jobId);
      }
      return `📅 Cancelled the linked platform event #${event.id}.`;
    }
    return `⚠️ The linked platform event #${event.id} is marked cancelled here, but the ${event.platform} cancel didn't go through — you may need to remove it by hand.`;
  } catch (err) {
    logger.warn({ err, rehearsalId: rehearsal.id }, 'Rehearsal native-event tie-in failed on cancel');
    return '⚠️ The linked platform event could not be cancelled.';
  }
}

/**
 * Lines describing the linked platform event for `!rehearsal show`: the
 * event status line plus RSVP counts where the platform provides them
 * (WhatsApp going/maybe/not-going, Discord interested). Empty when there
 * is no linked event or the lookup fails.
 */
export async function describeRehearsalEvent(
  rehearsal: Rehearsal,
  ctx: RehearsalPlatformContext,
): Promise<string[]> {
  if (rehearsal.nativeEventId === null) return [];

  try {
    const event = await getNativeEventById(rehearsal.nativeEventId);
    if (!event) return [];

    const lines = [`📅 Event: ${formatEventLine(event)}`];
    const rsvpLine = await buildNativeEventRsvpLine(event, ctx);
    if (rsvpLine) lines.push(rsvpLine);
    return lines;
  } catch (err) {
    logger.warn({ err, rehearsalId: rehearsal.id }, 'Rehearsal native-event tie-in failed on show');
    return [];
  }
}
