import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

vi.mock('../src/features/introductions.js', () => ({
  INTRODUCTIONS_JID: 'intros@g.us',
  hasResponded: () => false,
  looksLikeIntroduction: () => false,
  handleIntroduction: async () => null,
  markCatchupComplete: () => {},
}));

function fakeSock() {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    fetchMessageHistory: vi.fn().mockResolvedValue(undefined),
    ev: {
      on: (e: string, h: (...a: unknown[]) => void) => {
        if (!handlers.has(e)) handlers.set(e, new Set());
        handlers.get(e)!.add(h);
      },
      off: (e: string, h: (...a: unknown[]) => void) => { handlers.get(e)?.delete(h); },
      count: (e: string) => handlers.get(e)?.size ?? 0,
    },
  };
}

describe('registerIntroCatchUp disposer', () => {
  afterEach(() => vi.useRealTimers());

  it('dispose() removes listeners and prevents the history-request timer', async () => {
    vi.useFakeTimers();
    const { registerIntroCatchUp } = await import('../src/platforms/whatsapp/introductions-catchup.js');
    const sock = fakeSock();
    const dispose = registerIntroCatchUp(sock as never);
    expect(typeof dispose).toBe('function');
    const before = sock.ev.count('messages.upsert') + sock.ev.count('messaging-history.set');
    expect(before).toBe(2);
    dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    const after = sock.ev.count('messages.upsert') + sock.ev.count('messaging-history.set');
    expect(after).toBe(0);
    expect(sock.fetchMessageHistory).not.toHaveBeenCalled(); // timer cleared before its 5s fire
  });
});
