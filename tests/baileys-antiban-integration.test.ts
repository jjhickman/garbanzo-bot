import { describe, expect, it } from 'vitest';
import { AntiBan, classifyDisconnect } from 'baileys-antiban';

describe('baileys-antiban package contract', () => {
  it('permits a configured first send and records it through the reviewed API', async () => {
    const guard = new AntiBan({
      preset: 'conservative',
      maxPerMinute: 5,
      maxPerHour: 100,
      maxPerDay: 2000,
      minDelayMs: 0,
      maxDelayMs: 0,
      newChatDelayMs: 0,
      warmupDays: 0,
      logging: false,
    });

    const decision = await guard.beforeSend('test-group@g.us', 'hello');
    expect(decision.allowed).toBe(true);
    expect(decision.delayMs).toBeGreaterThanOrEqual(0);

    guard.afterSend('test-group@g.us', 'hello');
    expect(guard.getStats().messagesAllowed).toBe(1);
    guard.destroy();
  });

  it('classifies rate-limited disconnects with reconnect backoff', () => {
    const result = classifyDisconnect(429);
    expect(result.category).toBe('rate-limited');
    expect(result.shouldReconnect).toBe(true);
    expect(result.backoffMs).toBeGreaterThan(0);
  });
});
