import type { WASocket } from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { buildWeeklyRecap } from '../../features/recap.js';

const RECAP_WEEKDAY = 0; // Sunday
const RECAP_HOUR = 18; // 6 PM local time

/**
 * Schedule the weekly recap DM to the owner (Sunday evening).
 * Same disposer contract as scheduleDigest: each connection generation must
 * dispose the previous scheduler or timers stack across reconnects.
 */
export function scheduleWeeklyRecap(sock: WASocket): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  function arm(): void {
    if (cancelled) return;
    const msUntil = msUntilWeekdayHour(RECAP_WEEKDAY, RECAP_HOUR);
    const hoursUntil = Math.round((msUntil / 1000 / 60 / 60) * 10) / 10;
    logger.info({ nextRecapIn: `${hoursUntil}h` }, 'Weekly recap scheduled');

    timer = setTimeout(async () => {
      // Config schema requires OWNER_JID for the WhatsApp platform; this
      // narrows the conditional type at WhatsApp-only call sites.
      const ownerJid = config.OWNER_JID;
      try {
        if (!ownerJid) throw new Error('OWNER_JID is required for WhatsApp recap delivery');

        const text = await buildWeeklyRecap();
        await sock.sendMessage(ownerJid, { text });
        logger.info('Weekly recap sent');
      } catch (err) {
        logger.error({ err, ownerId: ownerJid }, 'Failed to send weekly recap');
      }
      arm(); // reschedule for next week
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

function msUntilWeekdayHour(weekday: number, hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);

  let daysAhead = (weekday - now.getDay() + 7) % 7;
  if (daysAhead === 0 && target <= now) daysAhead = 7;
  target.setDate(target.getDate() + daysAhead);

  return target.getTime() - now.getTime();
}

export const __testing = { msUntilWeekdayHour };
