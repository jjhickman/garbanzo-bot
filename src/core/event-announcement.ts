/**
 * Announcement-message rendering for native events on platforms that have
 * no calendar primitive (Telegram, Matrix). On those platforms the "event"
 * is honestly a formatted chat message: create posts it, update edits the
 * SAME message in place, and cancel edits it to a clearly cancelled
 * rendering. The text uses the bot-wide WhatsApp-style markdown vocabulary
 * (`*bold*`); each platform adapter's send path translates it (Telegram →
 * MarkdownV2, Matrix → body + formatted_body).
 *
 * The start-time rendering is shared with `!event show`/`!event list`
 * (features/native-events.ts) so an announcement and the command replies
 * always agree on how a time reads.
 */

import type { NativeEventPayload } from './platform-messenger.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function formatClockTime(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')}${suffix}`;
}

/** Local start time in the shared `!event` rendering: `Tue Jul 21 7:00pm`. */
export function formatEventStartTime(startAtMs: number): string {
  const date = new Date(startAtMs);
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()} ${formatClockTime(date)}`;
}

function formatWhenLine(startAtMs: number, endAtMs: number | undefined): string {
  const start = formatEventStartTime(startAtMs);
  if (endAtMs === undefined) return start;

  const startDate = new Date(startAtMs);
  const endDate = new Date(endAtMs);
  const sameDay = startDate.getFullYear() === endDate.getFullYear()
    && startDate.getMonth() === endDate.getMonth()
    && startDate.getDate() === endDate.getDate();
  return sameDay
    ? `${start} – ${formatClockTime(endDate)}`
    : `${start} – ${formatEventStartTime(endAtMs)}`;
}

/**
 * Build the announcement text for a native event. The cancelled rendering
 * keeps the full details so an edited-in-place announcement still says
 * what was called off and when it would have been.
 */
export function buildEventAnnouncementText(
  event: NativeEventPayload,
  opts: { cancelled?: boolean } = {},
): string {
  const lines = [
    opts.cancelled ? `❌ *CANCELLED — ${event.name}*` : `📅 *${event.name}*`,
    `🕒 ${formatWhenLine(event.startAtMs, event.endAtMs)}`,
  ];
  if (event.location) lines.push(`📍 ${event.location}`);
  if (event.description) lines.push('', event.description);
  return lines.join('\n');
}
