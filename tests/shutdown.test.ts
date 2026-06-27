import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

describe('memory watchdog does not block exit', () => {
  afterEach(() => vi.restoreAllMocks());
  it('calls unref() on its interval', async () => {
    const unref = vi.fn();
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue({ unref } as never);
    const { startMemoryWatchdog } = await import('../src/middleware/health.js');
    startMemoryWatchdog();
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});
