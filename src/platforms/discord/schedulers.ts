import type { PlatformMessenger } from '../../core/platform-messenger.js';
import { archiveDailyDigest, formatDigest } from '../../features/digest.js';
import { buildWeeklyRecap } from '../../features/recap.js';
import { logger } from '../../middleware/logger.js';
import { recordEventReminderSent, snapshotAndReset } from '../../middleware/stats.js';
import { config } from '../../utils/config.js';
import {
  cancelEventReminder,
  listPendingEventReminders,
  markEventReminderSent,
} from '../../utils/db.js';
import type { EventReminder } from '../../utils/db-types.js';

const DIGEST_HOUR = 21;
const RECAP_WEEKDAY = 0;
const RECAP_HOUR = 18;
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const CANCEL_AFTER_SECONDS = 30 * 60;
const MAX_FAILED_POLLS_AFTER_GRACE = 3;

export function scheduleDiscordDigest(
  messenger: PlatformMessenger,
  targetChannelId: string,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  function arm(): void {
    if (cancelled) return;
    const msUntilDigest = msUntilHour(DIGEST_HOUR);
    const hoursUntil = Math.round((msUntilDigest / 1000 / 60 / 60) * 10) / 10;
    logger.info(
      { nextDigestIn: `${hoursUntil}h`, targetHour: DIGEST_HOUR, targetChannelId },
      'Discord daily digest scheduled',
    );

    timer = setTimeout(async () => {
      try {
        await sendDigest(messenger, targetChannelId);
      } catch (err) {
        logger.error({ err, targetHour: DIGEST_HOUR, targetChannelId }, 'Failed to send Discord daily digest');
      }
      arm();
    }, msUntilDigest);
  }

  arm();

  return () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function scheduleDiscordWeeklyRecap(
  messenger: PlatformMessenger,
  targetChannelId: string,
): () => void {
  if (!config.WEEKLY_RECAP_ENABLED) {
    logger.info('Weekly recap disabled');
    return () => undefined;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  function arm(): void {
    if (cancelled) return;
    const msUntil = msUntilWeekdayHour(RECAP_WEEKDAY, RECAP_HOUR);
    const hoursUntil = Math.round((msUntil / 1000 / 60 / 60) * 10) / 10;
    logger.info({ nextRecapIn: `${hoursUntil}h`, targetChannelId }, 'Discord weekly recap scheduled');

    timer = setTimeout(async () => {
      try {
        const text = await buildWeeklyRecap();
        await messenger.sendText(targetChannelId, text);
        logger.info({ targetChannelId }, 'Discord weekly recap sent');
      } catch (err) {
        logger.error({ err, targetChannelId }, 'Failed to send Discord weekly recap');
      }
      arm();
    }, msUntil);
  }

  arm();

  return () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function scheduleDiscordEventReminders(messenger: PlatformMessenger): () => void {
  if (!config.EVENT_REMINDERS_ENABLED) {
    logger.info('Event reminders disabled');
    return () => undefined;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const failuresById = new Map<number, number>();

  function arm(): void {
    if (cancelled) return;
    timer = setTimeout(async () => {
      try {
        await pollEventReminders(messenger, failuresById);
      } catch (err) {
        logger.error({ err }, 'Discord event reminder poll failed');
      }
      arm();
    }, POLL_INTERVAL_MS);
    timer.unref?.();
  }

  arm();

  return () => {
    cancelled = true;
    failuresById.clear();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function sendDigest(
  messenger: PlatformMessenger,
  targetChannelId: string,
): Promise<string> {
  const stats = snapshotAndReset();
  const text = await formatDigest(stats);

  await archiveDailyDigest(stats);

  try {
    await messenger.sendText(targetChannelId, text);
    logger.info({ date: stats.date, targetChannelId }, 'Discord daily digest sent');
  } catch (err) {
    logger.error({ err, targetChannelId, date: stats.date }, 'Failed to send Discord digest');
  }

  return text;
}

async function pollEventReminders(
  messenger: PlatformMessenger,
  failuresById: Map<number, number>,
): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const due = await listPendingEventReminders(nowSeconds);

  for (const reminder of due) {
    try {
      await messenger.sendText(reminder.chatJid, formatReminder(reminder));
      await markEventReminderSent(reminder.id);
      recordEventReminderSent();
      failuresById.delete(reminder.id);
      logger.info(
        { reminderId: reminder.id, chatJid: reminder.chatJid },
        'Discord event reminder sent',
      );
    } catch (err) {
      const failures = (failuresById.get(reminder.id) ?? 0) + 1;
      failuresById.set(reminder.id, failures);
      logger.warn({ err, reminderId: reminder.id, failures }, 'Discord event reminder send failed');

      if (
        failures >= MAX_FAILED_POLLS_AFTER_GRACE
        && nowSeconds >= reminder.remindAt + CANCEL_AFTER_SECONDS
      ) {
        await cancelEventReminder(reminder.id);
        failuresById.delete(reminder.id);
        logger.warn(
          { reminderId: reminder.id },
          'Discord event reminder cancelled after repeated send failures',
        );
      }
    }
  }
}

function formatReminder(reminder: EventReminder): string {
  const localTime = new Date(reminder.eventAt * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `⏰ Reminder: ${reminder.activity} starts around ${localTime}${reminder.location ? ` at ${reminder.location}` : ''}`;
}

function msUntilHour(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);

  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

function msUntilWeekdayHour(weekday: number, hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);

  let daysAhead = (weekday - now.getDay() + 7) % 7;
  if (daysAhead === 0 && target <= now) daysAhead = 7;
  target.setDate(target.getDate() + daysAhead);

  return target.getTime() - now.getTime();
}
