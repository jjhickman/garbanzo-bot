// @vitest-environment jsdom
import { mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/api.js', () => ({
  ApiError: class ApiError extends Error {},
  exchangeEntryToken: vi.fn(),
  getState: vi.fn().mockResolvedValue({
    root: '/srv/garbanzo',
    shape: 'compose',
    composeFiles: ['compose.yml'],
    packageRepo: true,
    platform: 'discord',
    instanceId: 'boston-community',
    platforms: ['discord', 'whatsapp'],
    envFiles: { '.env': true, '.env.discord': true, '.env.whatsapp': false },
    configFiles: { 'discord-channels': true },
  }),
  clearSession: vi.fn(),
  onSessionExpired: vi.fn(() => () => undefined),
}));

import App from './App.svelte';

describe('configuration app shell (jsdom)', () => {
  let app: ReturnType<typeof mount> | undefined;

  afterEach(async () => {
    if (app) await unmount(app);
    app = undefined;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('moves from token entry to a deployment overview', async () => {
    app = mount(App, { target: document.body });
    const input = document.querySelector<HTMLInputElement>('input[name="entryToken"]');
    const form = document.querySelector<HTMLFormElement>('form');
    expect(input).not.toBeNull();
    expect(form).not.toBeNull();
    expect(document.body.textContent).toContain('One-time token');

    input!.value = 'pasted-token';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    form!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();

    expect(document.body.textContent).toContain('boston-community');
    expect(document.body.textContent).toContain('Discord');
    expect(document.body.textContent).toContain('Compose deployment');
    expect(document.body.textContent).toContain('.env.discord');
    expect(document.body.textContent).not.toContain('pasted-token');
  });
});
