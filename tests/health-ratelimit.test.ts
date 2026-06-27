import { describe, it, expect } from 'vitest';
import { __testing } from '../src/middleware/health.js';

describe('health rate-limit hygiene', () => {
  it('normalizes IPv6-mapped IPv4 to the same bucket', () => {
    expect(__testing.normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(__testing.normalizeIp('127.0.0.1')).toBe('127.0.0.1');
  });
});
