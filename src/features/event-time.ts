const MAX_EVENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_HOUR = 19;

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

interface TimeParts {
  hour: number;
  minute: number;
}

export function resolveEventTimestamp(date: string | null, time: string | null, now: Date): number | null {
  const dateOnly = resolveDate(date, now);
  if (!dateOnly) return null;

  const timeParts = resolveTime(time);
  if (!timeParts) return null;

  const event = new Date(dateOnly);
  event.setHours(timeParts.hour, timeParts.minute, 0, 0);

  const eventMs = event.getTime();
  if (eventMs <= now.getTime()) return null;
  if (eventMs - now.getTime() > MAX_EVENT_WINDOW_MS) return null;
  return eventMs;
}

function resolveDate(date: string | null, now: Date): Date | null {
  if (!date) return null;

  const normalized = date.trim().toLowerCase();
  if (normalized === 'today' || normalized === 'tonight') {
    return startOfLocalDay(now);
  }
  if (normalized === 'tomorrow') {
    const target = startOfLocalDay(now);
    target.setDate(target.getDate() + 1);
    return target;
  }

  const weekdayMatch = normalized.match(/^(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:morning|afternoon|evening|night))?$/);
  if (weekdayMatch) {
    const prefix = weekdayMatch[1] ?? '';
    const weekday = WEEKDAYS[weekdayMatch[2]];
    return resolveWeekday(now, weekday, prefix);
  }

  const numericMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (numericMatch) {
    const month = Number.parseInt(numericMatch[1], 10);
    const day = Number.parseInt(numericMatch[2], 10);
    return resolveMonthDay(now, month - 1, day);
  }

  const monthNameMatch = normalized.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})$/);
  if (monthNameMatch) {
    const month = MONTHS[monthNameMatch[1]];
    const day = Number.parseInt(monthNameMatch[2], 10);
    return resolveMonthDay(now, month, day);
  }

  return null;
}

function resolveTime(time: string | null): TimeParts | null {
  if (!time) return { hour: DEFAULT_EVENT_HOUR, minute: 0 };

  const normalized = time.trim().toLowerCase();
  if (normalized === 'noon') return { hour: 12, minute: 0 };

  const amPmMatch = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (amPmMatch) {
    const rawHour = Number.parseInt(amPmMatch[1], 10);
    const minute = amPmMatch[2] ? Number.parseInt(amPmMatch[2], 10) : 0;
    if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
    const period = amPmMatch[3];
    const hour = period === 'am'
      ? (rawHour === 12 ? 0 : rawHour)
      : (rawHour === 12 ? 12 : rawHour + 12);
    return { hour, minute };
  }

  const twentyFourHourMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    const hour = Number.parseInt(twentyFourHourMatch[1], 10);
    const minute = Number.parseInt(twentyFourHourMatch[2], 10);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  const bareAtMatch = normalized.match(/^at\s+(\d{1,2})(?::(\d{2}))?$/);
  if (bareAtMatch) {
    const rawHour = Number.parseInt(bareAtMatch[1], 10);
    const minute = bareAtMatch[2] ? Number.parseInt(bareAtMatch[2], 10) : 0;
    if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
    // Social event proposals with bare "at 8" overwhelmingly mean evening.
    const hour = rawHour >= 1 && rawHour <= 11 ? rawHour + 12 : rawHour;
    return { hour, minute };
  }

  return null;
}

function startOfLocalDay(date: Date): Date {
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return target;
}

function resolveWeekday(now: Date, targetWeekday: number, prefix: string): Date {
  const target = startOfLocalDay(now);
  const today = now.getDay();
  let daysUntil = (targetWeekday - today + 7) % 7;

  if (prefix === 'next') {
    daysUntil = daysUntil === 0 ? 7 : daysUntil + 7;
  }

  target.setDate(target.getDate() + daysUntil);
  return target;
}

function resolveMonthDay(now: Date, month: number, day: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  let target = new Date(now.getFullYear(), month, day, 0, 0, 0, 0);
  if (target.getMonth() !== month || target.getDate() !== day) return null;

  if (target.getTime() < startOfLocalDay(now).getTime()) {
    target = new Date(now.getFullYear() + 1, month, day, 0, 0, 0, 0);
    if (target.getMonth() !== month || target.getDate() !== day) return null;
  }

  return target;
}
