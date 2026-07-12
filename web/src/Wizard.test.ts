// @vitest-environment jsdom
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  exchangeEntryToken: vi.fn(),
  getState: vi.fn(),
  getWizardSchema: vi.fn(),
  submitWizard: vi.fn(),
  clearSession: vi.fn(),
  onSessionExpired: vi.fn(() => () => undefined),
}));

vi.mock('./lib/api.js', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly details: unknown) {
      super(message);
    }
  },
  ...apiMocks,
}));

import App from './App.svelte';
import { ApiError } from './lib/api.js';

const schema = {
  platforms: ['discord', 'telegram'],
  defaultPlatform: 'discord',
  deployTargets: ['docker', 'native'],
  providers: ['openrouter', 'openai'],
  vectorStores: ['qdrant', 'none'],
  openaiAuthModes: ['apikey', 'oauth'],
  whatsappLoginModes: ['web', 'terminal', 'both'],
  chatScopes: ['all', 'configured'],
  groups: {
    shared: [
      { env: 'OPENROUTER_API_KEY', cli: 'openrouter-key', default: '', secret: true },
      { env: 'OPENROUTER_MODEL', cli: 'openrouter-model', default: 'test/model', secret: false },
      { env: 'OPENAI_API_KEY', cli: 'openai-key', default: '', secret: true },
      { env: 'OPENAI_MODEL', cli: 'openai-model', default: 'test-openai', secret: false },
      { env: 'MONITORING_TOKEN', cli: 'monitoring-token', default: '', secret: true },
      { env: 'BRIDGE_ENABLED', cli: 'bridge-enabled', default: '', secret: false },
      { env: 'SHARED_MEMORY_ENABLED', cli: 'shared-memory-enabled', default: '', secret: false },
    ],
    whatsapp: [],
    discord: [
      { env: 'DISCORD_BOT_TOKEN', cli: 'discord-bot-token', default: '', secret: true },
      { env: 'DISCORD_OWNER_ID', cli: 'discord-owner-id', default: '', secret: false },
      { env: 'BAND_FEATURES_ENABLED', cli: 'band-features-enabled', default: 'false', secret: false },
    ],
    telegram: [
      { env: 'TELEGRAM_BOT_TOKEN', cli: 'telegram-bot-token', default: '', secret: true },
    ],
    matrix: [],
  },
};

describe('first-run wizard (jsdom)', () => {
  let app: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    apiMocks.getState.mockResolvedValue({
      root: '/tmp/empty-garbanzo', shape: 'bare', composeFiles: [], packageRepo: false,
      platform: null, instanceId: null, platforms: [],
      envFiles: { '.env': false, '.env.discord': false }, configFiles: { 'discord-channels': false },
    });
    apiMocks.getWizardSchema.mockResolvedValue(schema);
    apiMocks.submitWizard.mockResolvedValue({ ok: true, written: ['.env', '.env.discord'] });
  });

  afterEach(async () => {
    if (app) await unmount(app);
    app = undefined;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  async function clickButton(label: string): Promise<void> {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === label);
    expect(button, `button ${label}`).toBeDefined();
    if (!button) throw new Error(`button ${label} did not render`);
    button.click();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }

  async function connect(): Promise<void> {
    app = mount(App, { target: document.body });
    const input = document.querySelector<HTMLInputElement>('input[name="entryToken"]');
    if (!input) throw new Error('entry token input did not render');
    input.value = 'entry-token';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    await clickButton('Connect securely');
  }

  async function reachReview(): Promise<void> {
    await connect();
    await clickButton('Next');
    await clickButton('Next');
    const providerSecret = document.querySelector<HTMLInputElement>('input[name="OPENROUTER_API_KEY"]');
    if (!providerSecret) throw new Error('provider secret input did not render');
    providerSecret.value = 'provider-secret-canary';
    providerSecret.dispatchEvent(new Event('input', { bubbles: true }));
    await clickButton('Next');
    await clickButton('Next');
    const platformSecret = document.querySelector<HTMLInputElement>('input[name="DISCORD_BOT_TOKEN"]');
    if (!platformSecret) throw new Error('platform secret input did not render');
    platformSecret.value = 'discord-secret-canary';
    platformSecret.dispatchEvent(new Event('input', { bubbles: true }));
    const owner = document.querySelector<HTMLInputElement>('input[name="DISCORD_OWNER_ID"]');
    if (!owner) throw new Error('owner input did not render');
    owner.value = '123456789012345678';
    owner.dispatchEvent(new Event('input', { bubbles: true }));
    const channel = document.querySelector<HTMLInputElement>('input[name="binding-0-id"]');
    if (!channel) throw new Error('channel binding input did not render');
    channel.value = '234567890123456789';
    channel.dispatchEvent(new Event('input', { bubbles: true }));
    await clickButton('Next');
  }

  it('renders platform choices from the mocked schema', async () => {
    await connect();
    expect(document.body.textContent).toContain('Configure this instance');
    expect(document.body.textContent).toContain('Discord');
    expect(document.body.textContent).toContain('Telegram');
    expect(apiMocks.getWizardSchema).toHaveBeenCalledOnce();
  });

  it('renders secret fields as empty password inputs', async () => {
    await connect();
    await clickButton('Next');
    await clickButton('Next');
    const secret = document.querySelector<HTMLInputElement>('input[name="OPENROUTER_API_KEY"]');
    expect(secret?.type).toBe('password');
    expect(secret?.value).toBe('');
  });

  it('submits ENV-keyed fields and masks every secret in review', async () => {
    await reachReview();
    expect(document.body.textContent).not.toContain('provider-secret-canary');
    expect(document.body.textContent).not.toContain('discord-secret-canary');
    expect(document.body.textContent).toContain('set');
    await clickButton('Create configuration');
    expect(apiMocks.submitWizard).toHaveBeenCalledWith(expect.objectContaining({
      MESSAGING_PLATFORM: 'discord',
      DEPLOY_TARGET: 'docker',
      AI_PROVIDER_ORDER: 'openrouter',
      OPENROUTER_API_KEY: 'provider-secret-canary',
      DISCORD_BOT_TOKEN: 'discord-secret-canary',
      DISCORD_OWNER_ID: '123456789012345678',
    }), ['--discord-channel-ids=234567890123456789', '--discord-channel-name=general']);
  });

  it('shows the written files after a 200 response', async () => {
    await reachReview();
    await clickButton('Create configuration');
    expect(document.body.textContent).toContain('Your first-run files are ready');
    expect(document.body.textContent).toContain('.env.discord');
    expect(document.body.textContent).toContain('Next: review the generated configuration, then use Apply');
  });

  it('shows recovery guidance after a 409 response', async () => {
    apiMocks.submitWizard.mockRejectedValue(new ApiError('conflict', 409, {}));
    await reachReview();
    await clickButton('Create configuration');
    expect(document.body.textContent).toContain('config root is not empty');
  });

  it('maps 422 issues to the offending field', async () => {
    apiMocks.submitWizard.mockRejectedValue(new ApiError('invalid', 422, {
      issues: [{ path: ['DISCORD_OWNER_ID'], message: 'Owner ID is invalid' }],
    }));
    await reachReview();
    await clickButton('Create configuration');
    expect(document.body.textContent).toContain('Some configuration values need attention');
    expect(document.querySelector('[data-field="DISCORD_OWNER_ID"]')?.textContent).toContain('Owner ID is invalid');
  });
});
