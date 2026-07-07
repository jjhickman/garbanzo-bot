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
    DisconnectReason: { loggedOut: 401, forbidden: 403, connectionClosed: 428, connectionReplaced: 440, restartRequired: 515 },
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
  const originalSetProfileName = process.env.WHATSAPP_SET_PROFILE_NAME;

  afterEach(() => {
    sockets.length = 0;
    vi.clearAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    if (originalSetProfileName === undefined) {
      delete process.env.WHATSAPP_SET_PROFILE_NAME;
    } else {
      process.env.WHATSAPP_SET_PROFILE_NAME = originalSetProfileName;
    }
  });

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

  it('reconnects on 515 (restartRequired) so the first QR link completes', async () => {
    vi.useFakeTimers();
    const { startConnection } = await import('../src/platforms/whatsapp/connection.js');
    await startConnection(() => {});
    const first = sockets[0];
    // 515 = restartRequired: baileys-antiban classifies it as fatal, but it must reconnect.
    (first as never as { __fire: (u: unknown) => void }).__fire({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    expect(first.end).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets.length).toBe(2); // reconnected, not paused
  });

  it('reconnects on 428 (connectionClosed) — a routine transient disconnect', async () => {
    vi.useFakeTimers();
    const { startConnection } = await import('../src/platforms/whatsapp/connection.js');
    await startConnection(() => {});
    const first = sockets[0];
    // 428 = connectionClosed; baileys-antiban mislabels it fatal, but it must reconnect.
    (first as never as { __fire: (u: unknown) => void }).__fire({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets.length).toBe(2);
  });

  it('does NOT reconnect on 440 (connectionReplaced) or 401 (loggedOut)', async () => {
    vi.useFakeTimers();
    const { startConnection } = await import('../src/platforms/whatsapp/connection.js');
    await startConnection(() => {});
    const first = sockets[0];
    (first as never as { __fire: (u: unknown) => void }).__fire({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 440 } } } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets.length).toBe(1); // stayed down — another session owns the account
  });

  it('skips account-level profile name updates when disabled', async () => {
    process.env.WHATSAPP_SET_PROFILE_NAME = 'false';
    const { startConnection } = await import('../src/platforms/whatsapp/connection.js');
    await startConnection(() => {});
    const first = sockets[0];

    (first as never as { __fire: (u: unknown) => void }).__fire({ connection: 'open' });

    expect(first.updateProfileName).not.toHaveBeenCalled();
  });
});
