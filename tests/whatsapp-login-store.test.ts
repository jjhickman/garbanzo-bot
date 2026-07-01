process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it, vi } from 'vitest';

const qrcodeTerminal = vi.hoisted(() => ({
  generate: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({
  default: qrcodeTerminal,
}));

describe('WhatsApp login store', () => {
  afterEach(async () => {
    const store = await import('../src/platforms/whatsapp/login-store.js');
    store.__resetLoginStore();
    qrcodeTerminal.generate.mockReset();
    vi.restoreAllMocks();
  });

  it('publishQr stores a pending QR snapshot and notifies subscribers', async () => {
    const { getSnapshot, publishQr, subscribe } = await import('../src/platforms/whatsapp/login-store.js');
    const listener = vi.fn();
    const throwingListener = vi.fn(() => {
      throw new Error('subscriber failed');
    });

    subscribe(throwingListener);
    subscribe(listener);
    publishQr('qr-one');

    expect(getSnapshot()).toEqual({ state: 'pending', qr: 'qr-one' });
    expect(throwingListener).toHaveBeenCalledWith({ state: 'pending', qr: 'qr-one' });
    expect(listener).toHaveBeenCalledWith({ state: 'pending', qr: 'qr-one' });
  });

  it('markLinked clears the QR and marks the snapshot linked', async () => {
    const { getSnapshot, markLinked, publishQr } = await import('../src/platforms/whatsapp/login-store.js');

    publishQr('qr-two');
    markLinked();

    expect(getSnapshot()).toEqual({ state: 'linked', qr: null });
  });

  it('unsubscribe stops further notifications', async () => {
    const { markLinked, publishQr, subscribe } = await import('../src/platforms/whatsapp/login-store.js');
    const listener = vi.fn();

    const unsubscribe = subscribe(listener);
    publishQr('qr-three');
    unsubscribe();
    markLinked();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ state: 'pending', qr: 'qr-three' });
  });

  it('routeLoginQr in web mode publishes without writing a terminal QR', async () => {
    const { getSnapshot, routeLoginQr, subscribe } = await import('../src/platforms/whatsapp/login-store.js');
    const listener = vi.fn();
    subscribe(listener);

    routeLoginQr('qr-web', 'web');

    expect(getSnapshot()).toEqual({ state: 'pending', qr: 'qr-web' });
    expect(listener).toHaveBeenCalledWith({ state: 'pending', qr: 'qr-web' });
    expect(qrcodeTerminal.generate).not.toHaveBeenCalled();
  });

  it('routeLoginQr in terminal mode writes a terminal QR without publishing', async () => {
    const { getSnapshot, routeLoginQr, subscribe } = await import('../src/platforms/whatsapp/login-store.js');
    const listener = vi.fn();
    subscribe(listener);

    routeLoginQr('qr-terminal', 'terminal');

    expect(qrcodeTerminal.generate).toHaveBeenCalledWith('qr-terminal', { small: true });
    expect(getSnapshot()).toEqual({ state: 'pending', qr: null });
    expect(listener).not.toHaveBeenCalled();
  });

  it('routeLoginQr in both mode writes a terminal QR and publishes', async () => {
    const { getSnapshot, routeLoginQr, subscribe } = await import('../src/platforms/whatsapp/login-store.js');
    const listener = vi.fn();
    subscribe(listener);

    routeLoginQr('qr-both', 'both');

    expect(qrcodeTerminal.generate).toHaveBeenCalledWith('qr-both', { small: true });
    expect(getSnapshot()).toEqual({ state: 'pending', qr: 'qr-both' });
    expect(listener).toHaveBeenCalledWith({ state: 'pending', qr: 'qr-both' });
  });

  it('tracks the active socket reference', async () => {
    const { getActiveSocket, setActiveSocket } = await import('../src/platforms/whatsapp/login-store.js');
    const sock = { user: { id: 'test@s.whatsapp.net' } };

    setActiveSocket(sock as never);
    expect(getActiveSocket()).toBe(sock);

    setActiveSocket(null);
    expect(getActiveSocket()).toBeNull();
  });
});
