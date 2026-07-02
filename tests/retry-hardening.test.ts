import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

function installLoggerMock() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  vi.doMock('../src/middleware/logger.js', () => ({ logger }));
  return logger;
}

describe('Retry hardening', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('preserves current behavior when no per-attempt timeout is configured', async () => {
    vi.useFakeTimers();
    const logger = installLoggerMock();
    const {
      queueRetry,
      setRetryHandler,
      clearRetryQueue,
    } = await import('../src/middleware/retry.js');

    const handler = vi.fn(() => new Promise<void>(() => {}));
    setRetryHandler(handler);

    expect(queueRetry({
      groupJid: 'g1@g.us',
      senderJid: 'u1@s.whatsapp.net',
      query: 'q',
      timestamp: 1,
    })).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(logger.error).not.toHaveBeenCalled();

    clearRetryQueue();
  });

  it('logs and drops a retry attempt that exceeds the configured timeout', async () => {
    vi.useFakeTimers();
    const logger = installLoggerMock();
    const { config } = await import('../src/utils/config.js');
    config.RETRY_ATTEMPT_TIMEOUT_MS = 1000;

    const {
      queueRetry,
      setRetryHandler,
      getRetryQueueSize,
      clearRetryQueue,
    } = await import('../src/middleware/retry.js');

    const handler = vi.fn(() => new Promise<void>(() => {}));
    setRetryHandler(handler);

    expect(queueRetry({
      groupJid: 'g2@g.us',
      senderJid: 'u2@s.whatsapp.net',
      query: 'q',
      timestamp: 2,
    })).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getRetryQueueSize()).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [meta, message] = logger.error.mock.calls[0] ?? [];
    expect(message).toBe('Retry also failed — message dropped');
    expect((meta as { err: Error }).err.message).toBe('Retry attempt timed out after 1000ms');

    clearRetryQueue();
  });
});
