import { describe, it, expect, vi, afterEach } from 'vitest';

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
