import type { WASocket } from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import {
  cancelEventReminder,
  listPendingEventReminders,
  markEventReminderSent,
} from '../../utils/db.js';
import type { EventReminder } from '../../utils/db-types.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const CANCEL_AFTER_SECONDS = 30 * 60;
const MAX_FAILED_POLLS_AFTER_GRACE = 3;

export function scheduleEventReminders(sock: WASocket): () => void {
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
        await poll(sock, failuresById);
      } catch (err) {
        logger.error({ err }, 'Event reminder poll failed');
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

async function poll(sock: WASocket, failuresById: Map<number, number>): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const due = await listPendingEventReminders(nowSeconds);

  for (const reminder of due) {
    try {
      await sock.sendMessage(reminder.chatJid, { text: formatReminder(reminder) });
      await markEventReminderSent(reminder.id);
      failuresById.delete(reminder.id);
      logger.info({ reminderId: reminder.id, chatJid: reminder.chatJid }, 'Event reminder sent');
    } catch (err) {
      const failures = (failuresById.get(reminder.id) ?? 0) + 1;
      failuresById.set(reminder.id, failures);
      logger.warn({ err, reminderId: reminder.id, failures }, 'Event reminder send failed');

      if (
        failures >= MAX_FAILED_POLLS_AFTER_GRACE
        && nowSeconds >= reminder.remindAt + CANCEL_AFTER_SECONDS
      ) {
        await cancelEventReminder(reminder.id);
        failuresById.delete(reminder.id);
        logger.warn({ reminderId: reminder.id }, 'Event reminder cancelled after repeated send failures');
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
