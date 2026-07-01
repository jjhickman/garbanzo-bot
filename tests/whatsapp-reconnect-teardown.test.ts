import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

const sockets: Array<{
  ev: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
  end: ReturnType<typeof vi.fn>;
  updateProfileName: ReturnType<typeof vi.fn>;
  user?: unknown;
}> = [];

vi.mock('@whiskeysockets/baileys', () => {
  const makeWASocket = vi.fn(() => {
    let updateCb: ((u: unknown) => void) | null = null;
    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      updateProfileName: vi.fn().mockResolvedValue(undefined),
      end: vi.fn(),
      ev: {
        on: vi.fn((evt: string, cb: (u: unknown) => void) => { if (evt === 'connection.update') updateCb = cb; }),
        off: vi.fn(),
      },
      __fire: (u: unknown) => updateCb?.(u),
    };
    sockets.push(sock as never);
    return sock;
  });
  return {
    default: makeWASocket,
    DisconnectReason: { loggedOut: 401 },
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn() }),
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3, 4] }),
    makeCacheableSignalKeyStore: vi.fn((k: unknown) => k),
  };
});
vi.mock('../src/platforms/whatsapp/outbound-safety.js', () => ({
  createProtectedWhatsAppSocket: (s: unknown) => s,
  getWhatsAppOutboundSafety: () => ({ onConnected: vi.fn(), onDisconnected: vi.fn(), destroy: vi.fn() }),
}));

describe('reconnect teardown', () => {
  afterEach(() => { sockets.length = 0; vi.clearAllMocks(); vi.useRealTimers(); });

  it('ends the old socket before scheduling a reconnect', async () => {
    vi.useFakeTimers();
    const { startConnection } = await import('../src/platforms/whatsapp/connection.js');
    await startConnection(() => {});
    const first = sockets[0];
    // Fire a non-loggedOut close (e.g. 500 -> reconnect)
    (first as never as { __fire: (u: unknown) => void }).__fire({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    expect(sockets.length).toBe(1);
    expect(first.ev.off).toHaveBeenCalledWith('connection.update', expect.any(Function));
    expect(first.end).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets.length).toBe(2);
  });
});
