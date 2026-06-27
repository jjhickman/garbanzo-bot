import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

const disposeSpies: Array<() => void> = [];

vi.mock('../src/platforms/whatsapp/connection.js', () => ({
  startConnection: vi.fn(async (onReady: (s: unknown) => void) => {
    const sock = { end: vi.fn(), ev: { removeAllListeners: vi.fn() } };
    onReady(sock);
    return sock;
  }),
}));
vi.mock('../src/platforms/whatsapp/handlers.js', () => ({ registerWhatsAppHandlers: vi.fn() }));
vi.mock('../src/platforms/whatsapp/digest.js', () => ({
  scheduleDigest: vi.fn(() => { const d = vi.fn(); disposeSpies.push(d); return d; }),
}));
vi.mock('../src/platforms/whatsapp/introductions-catchup.js', () => ({
  registerIntroCatchUp: vi.fn(() => { const d = vi.fn(); disposeSpies.push(d); return d; }),
}));

describe('WhatsApp runtime lifecycle', () => {
  afterEach(() => { disposeSpies.length = 0; vi.clearAllMocks(); });

  it('stop() disposes all registrations exactly once', async () => {
    const { createWhatsAppRuntime } = await import('../src/platforms/whatsapp/runtime.js');
    const rt = createWhatsAppRuntime();
    await rt.start();
    expect(disposeSpies.length).toBe(2); // digest + intro
    await rt.stop();
    for (const d of disposeSpies) expect(d).toHaveBeenCalledTimes(1);
  });
});
