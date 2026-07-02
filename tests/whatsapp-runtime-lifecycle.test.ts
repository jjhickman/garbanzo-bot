import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

type ReadyCallback = (sock: unknown) => void;
type ClosedCallback = () => void;

const lifecycle = vi.hoisted(() => ({
  capturedOnReady: null as ReadyCallback | null,
  capturedOnClosed: null as ClosedCallback | undefined,
  disposeSpies: [] as Array<ReturnType<typeof vi.fn>>,
  events: [] as string[],
}));

function fakeSock(name: string) {
  return { name, end: vi.fn(), ev: { removeAllListeners: vi.fn() } };
}

vi.mock('../src/platforms/whatsapp/connection.js', () => ({
  startConnection: vi.fn(async (onReady: ReadyCallback, onClosed?: ClosedCallback) => {
    lifecycle.capturedOnReady = onReady;
    lifecycle.capturedOnClosed = onClosed;
    return { name: 'start-return', end: vi.fn(), ev: { removeAllListeners: vi.fn() } };
  }),
}));
vi.mock('../src/platforms/whatsapp/handlers.js', () => ({ registerWhatsAppHandlers: vi.fn() }));
vi.mock('../src/platforms/whatsapp/digest.js', () => ({
  scheduleDigest: vi.fn((sock: { name: string }) => {
    lifecycle.events.push(`digest-register-${sock.name}`);
    const dispose = vi.fn(() => lifecycle.events.push(`digest-dispose-${sock.name}`));
    lifecycle.disposeSpies.push(dispose);
    return dispose;
  }),
}));
vi.mock('../src/platforms/whatsapp/event-reminders.js', () => ({
  scheduleEventReminders: vi.fn((sock: { name: string }) => {
    lifecycle.events.push(`event-reminders-register-${sock.name}`);
    const dispose = vi.fn(() => lifecycle.events.push(`event-reminders-dispose-${sock.name}`));
    lifecycle.disposeSpies.push(dispose);
    return dispose;
  }),
}));
vi.mock('../src/platforms/whatsapp/introductions-catchup.js', () => ({
  registerIntroCatchUp: vi.fn((sock: { name: string }) => {
    lifecycle.events.push(`intro-register-${sock.name}`);
    const dispose = vi.fn(() => lifecycle.events.push(`intro-dispose-${sock.name}`));
    lifecycle.disposeSpies.push(dispose);
    return dispose;
  }),
}));

describe('WhatsApp runtime lifecycle', () => {
  afterEach(() => {
    lifecycle.capturedOnReady = null;
    lifecycle.capturedOnClosed = undefined;
    lifecycle.disposeSpies.length = 0;
    lifecycle.events.length = 0;
    vi.clearAllMocks();
  });

  it('stop() disposes all registrations exactly once', async () => {
    const { createWhatsAppRuntime } = await import('../src/platforms/whatsapp/runtime.js');
    const rt = createWhatsAppRuntime();
    await rt.start();
    lifecycle.capturedOnReady?.(fakeSock('A'));
    expect(lifecycle.disposeSpies.length).toBe(3); // intro + digest + event reminders
    await rt.stop();
    for (const d of lifecycle.disposeSpies) expect(d).toHaveBeenCalledTimes(1);
  });

  it('disposes the previous generation before registering the next one', async () => {
    const { createWhatsAppRuntime } = await import('../src/platforms/whatsapp/runtime.js');
    const rt = createWhatsAppRuntime();
    await rt.start();

    lifecycle.capturedOnReady?.(fakeSock('A'));
    const generationA = [...lifecycle.disposeSpies];

    lifecycle.capturedOnReady?.(fakeSock('B'));

    expect(generationA).toHaveLength(3);
    for (const dispose of generationA) expect(dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.events).toEqual([
      'intro-register-A',
      'digest-register-A',
      'event-reminders-register-A',
      'intro-dispose-A',
      'digest-dispose-A',
      'event-reminders-dispose-A',
      'intro-register-B',
      'digest-register-B',
      'event-reminders-register-B',
    ]);

    const generationB = lifecycle.disposeSpies.slice(3);
    for (const dispose of generationB) expect(dispose).not.toHaveBeenCalled();

    await rt.stop();

    for (const dispose of generationA) expect(dispose).toHaveBeenCalledTimes(1);
    for (const dispose of generationB) expect(dispose).toHaveBeenCalledTimes(1);
  });
});
