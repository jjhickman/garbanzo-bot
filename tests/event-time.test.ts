import { describe, expect, it } from 'vitest';

import { resolveEventTimestamp } from '../src/features/event-time.js';

const baseNow = new Date(2026, 0, 10, 12, 0, 0, 0); // Saturday noon, local time

function at(year: number, monthIndex: number, day: number, hour: number, minute = 0): number {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

describe('resolveEventTimestamp', () => {
  it('resolves today, tonight, and tomorrow with explicit or default times', () => {
    expect(resolveEventTimestamp('today', '7pm', baseNow)).toBe(at(2026, 0, 10, 19));
    expect(resolveEventTimestamp('tonight', null, baseNow)).toBe(at(2026, 0, 10, 19));
    expect(resolveEventTimestamp('tomorrow', 'noon', baseNow)).toBe(at(2026, 0, 11, 12));
  });

  it('resolves bare weekdays to the next occurrence, including today', () => {
    expect(resolveEventTimestamp('saturday', '7pm', baseNow)).toBe(at(2026, 0, 10, 19));
    expect(resolveEventTimestamp('friday', '7pm', baseNow)).toBe(at(2026, 0, 16, 19));
  });

  it('resolves this/next weekday prefixes', () => {
    expect(resolveEventTimestamp('this sunday', '19:00', baseNow)).toBe(at(2026, 0, 11, 19));
    expect(resolveEventTimestamp('next saturday', '7pm', baseNow)).toBe(at(2026, 0, 17, 19));
  });

  it('resolves numeric and month-name dates within 30 days', () => {
    expect(resolveEventTimestamp('1/15', '7:30pm', baseNow)).toBe(at(2026, 0, 15, 19, 30));
    expect(resolveEventTimestamp('jan 15', null, baseNow)).toBe(at(2026, 0, 15, 19));
  });

  it('rolls near-year numeric dates forward only when still within 30 days', () => {
    const decNow = new Date(2026, 11, 30, 12, 0, 0, 0);
    expect(resolveEventTimestamp('1/2', '7pm', decNow)).toBe(at(2027, 0, 2, 19));
  });

  it('parses supported time formats', () => {
    expect(resolveEventTimestamp('tomorrow', '8pm', baseNow)).toBe(at(2026, 0, 11, 20));
    expect(resolveEventTimestamp('tomorrow', 'at 8', baseNow)).toBe(at(2026, 0, 11, 20));
    expect(resolveEventTimestamp('tomorrow', '19:45', baseNow)).toBe(at(2026, 0, 11, 19, 45));
    expect(resolveEventTimestamp('tomorrow', '12am', baseNow)).toBe(at(2026, 0, 11, 0));
  });

  it('returns null rather than guessing for unsupported or unsafe inputs', () => {
    expect(resolveEventTimestamp(null, '7pm', baseNow)).toBeNull();
    expect(resolveEventTimestamp('next weekend', '7pm', baseNow)).toBeNull();
    expect(resolveEventTimestamp('tomorrow', 'evening', baseNow)).toBeNull();
    expect(resolveEventTimestamp('13/40', '7pm', baseNow)).toBeNull();
  });

  it('rejects resolved timestamps in the past or more than 30 days out', () => {
    expect(resolveEventTimestamp('today', '11am', baseNow)).toBeNull();
    expect(resolveEventTimestamp('2/15', '7pm', baseNow)).toBeNull();
  });
});
