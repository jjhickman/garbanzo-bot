import type { WASocket } from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { snapshotAndReset } from '../../middleware/stats.js';
import { archiveDailyDigest, formatDigest } from '../../features/digest.js';

const DIGEST_HOUR = 21; // 9 PM local time

/**
 * Schedule the daily digest. Call once at startup.
 * Automatically reschedules after each digest send.
 */
export function scheduleDigest(sock: WASocket): void {
  const msUntilDigest = msUntilHour(DIGEST_HOUR);
  const hoursUntil = Math.round((msUntilDigest / 1000 / 60 / 60) * 10) / 10;

  logger.info({ nextDigestIn: `${hoursUntil}h`, targetHour: DIGEST_HOUR }, 'Daily digest scheduled');

  setTimeout(async () => {
    try {
      await sendDigest(sock);
    } catch (err) {
      logger.error({ err, targetHour: DIGEST_HOUR }, 'Failed to send daily digest');
    }

    // Reschedule for tomorrow
    scheduleDigest(sock);
  }, msUntilDigest);
}

async function sendDigest(sock: WASocket): Promise<string> {
  const stats = snapshotAndReset();
  const text = formatDigest(stats);

  // Archive to SQLite
  archiveDailyDigest(stats);

  try {
    await sock.sendMessage(config.OWNER_JID, { text });
    logger.info({ date: stats.date }, 'Daily digest sent');
  } catch (err) {
    logger.error({ err, ownerId: config.OWNER_JID, date: stats.date }, 'Failed to send digest to owner DM');
  }

  return text;
}

/** Calculate milliseconds from now until the next occurrence of a given hour */
function msUntilHour(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);

  // If we've already passed this hour today, schedule for tomorrow
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}
