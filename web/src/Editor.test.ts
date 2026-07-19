// @vitest-environment jsdom
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getWizardSchema: vi.fn(),
  putConfig: vi.fn(),
  putConfigFile: vi.fn(),
  validateConfig: vi.fn(),
  exportBundle: vi.fn(),
  importBundle: vi.fn(),
  confirmImport: vi.fn(),
  applyStream: vi.fn(),
}));

vi.mock('./lib/api.js', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly details: unknown) {
      super(message);
    }
  },
  ...apiMocks,
}));

import Editor from './lib/editor/Editor.svelte';
import { ApiError } from './lib/api.js';

const schema = {
  platforms: ['discord'], defaultPlatform: 'discord', deployTargets: ['docker'],
  providers: ['openai'], vectorStores: ['qdrant'], openaiAuthModes: ['apikey'],
  whatsappLoginModes: ['web'], chatScopes: ['configured'],
  groups: {
    shared: [
      { env: 'OPENAI_MODEL', cli: 'openai-model', default: 'gpt-test', secret: false },
      { env: 'OPENAI_API_KEY', cli: 'openai-key', default: '', secret: true },
      { env: 'MONITORING_TOKEN', cli: 'monitoring-token', default: '', secret: true },
    ],
    discord: [{ env: 'DISCORD_BOT_TOKEN', cli: 'discord-token', default: '', secret: true }],
    whatsapp: [], telegram: [], matrix: [],
  },
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    mtimeMs: 10,
    fileMtimes: { '.env': 5, '.env.discord': 10 },
    fileHashes: { '.env': 'shared-hash', '.env.discord': 'discord-hash' },
    env: {
      OPENAI_MODEL: 'gpt-test',
      OPENAI_API_KEY: { set: true },
      MONITORING_TOKEN: { set: true },
      DISCORD_BOT_TOKEN: { set: true },
    },
    files: {
      groups: { value: { groups: [] }, mtimeMs: 21, sha256: 'groups-hash' },
      'discord-channels': { value: { channels: [] }, mtimeMs: 22, sha256: 'discord-channels-hash' },
      'telegram-chats': null,
      'matrix-rooms': null,
      'bridge-map': { value: { routes: [] }, mtimeMs: 23, sha256: 'bridge-map-hash' },
    },
    ...overrides,
  };
}

describe('existing configuration editor (jsdom)', () => {
  let app: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    apiMocks.getConfig.mockResolvedValue(snapshot());
    apiMocks.getWizardSchema.mockResolvedValue(schema);
    apiMocks.putConfig.mockResolvedValue({ ok: true, mtimeMs: 11 });
    apiMocks.putConfigFile.mockResolvedValue({ ok: true, mtimeMs: 24 });
    apiMocks.validateConfig.mockResolvedValue({ ok: true, issues: [] });
    apiMocks.applyStream.mockImplementation(async (onChunk: (chunk: string) => void) => {
      onChunk('$ docker compose up -d discord\n');
      onChunk('started\nexit 0\n');
      return { text: '$ docker compose up -d discord\nstarted\nexit 0\n', exitCode: 0 };
    });
    apiMocks.importBundle.mockResolvedValue({ stagingId: 'stage-1', diff: { '.env': 'OPENAI_API_KEY=<redacted>' } });
    apiMocks.confirmImport.mockResolvedValue({ ok: true, changed: ['.env'] });
  });

  afterEach(async () => {
    if (app) await unmount(app);
    app = undefined;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  async function render(): Promise<void> {
    app = mount(Editor, { target: document.body, props: { platform: 'discord' } });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }

  async function click(label: string): Promise<void> {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === label);
    expect(button, `button ${label}`).toBeDefined();
    button?.click();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }

  function input(name: string): HTMLInputElement {
    const element = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!element) throw new Error(`input ${name} did not render`);
    return element;
  }

  it('loads current values while masking every set secret', async () => {
    await render();
    expect(apiMocks.getConfig).toHaveBeenCalledOnce();
    expect(apiMocks.getWizardSchema).toHaveBeenCalledOnce();
    expect(input('OPENAI_MODEL').value).toBe('gpt-test');
    expect(input('OPENAI_API_KEY').type).toBe('password');
    expect(input('OPENAI_API_KEY').value).toBe('');
    expect(input('OPENAI_API_KEY').placeholder).toContain('Leave blank to keep');
    expect(document.querySelector('[data-field="OPENAI_API_KEY"]')?.textContent).toContain('Set');
  });

  it('saves changed plain and secret fields while omitting unchanged secrets', async () => {
    await render();
    const model = input('OPENAI_MODEL');
    model.value = 'gpt-next';
    model.dispatchEvent(new Event('input', { bubbles: true }));
    const secret = input('OPENAI_API_KEY');
    secret.value = 'test_key_changed';
    secret.dispatchEvent(new Event('input', { bubbles: true }));
    await click('Save settings');

    expect(apiMocks.putConfig).toHaveBeenCalledWith({
      mtimeMs: 10,
      fileMtimes: { '.env': 5, '.env.discord': 10 },
      fileHashes: { '.env': 'shared-hash', '.env.discord': 'discord-hash' },
      update: { OPENAI_MODEL: 'gpt-next', OPENAI_API_KEY: 'test_key_changed' },
    });
    expect(apiMocks.putConfig.mock.calls[0]?.[0].update).not.toHaveProperty('MONITORING_TOKEN');
  });

  it('sends null only when a secret is explicitly cleared', async () => {
    await render();
    const clear = input('OPENAI_API_KEY-clear');
    clear.checked = true;
    clear.dispatchEvent(new Event('change', { bubbles: true }));
    await click('Save settings');
    expect(apiMocks.putConfig.mock.calls[0]?.[0].update).toEqual({ OPENAI_API_KEY: null });
  });

  it('offers a reload path after changed-on-disk conflict', async () => {
    apiMocks.putConfig.mockRejectedValueOnce(new ApiError('conflict', 409, { reason: 'changed-on-disk' }));
    await render();
    const model = input('OPENAI_MODEL');
    model.value = 'gpt-next';
    model.dispatchEvent(new Event('input', { bubbles: true }));
    await click('Save settings');
    expect(document.body.textContent).toContain('changed on disk');
    await click('Reload');
    expect(apiMocks.getConfig).toHaveBeenCalledTimes(2);
  });

  it('maps validation issues to the matching environment field', async () => {
    apiMocks.putConfig.mockRejectedValueOnce(new ApiError('invalid', 422, {
      issues: [{ path: ['OPENAI_MODEL'], message: 'Model is not available' }],
    }));
    await render();
    const model = input('OPENAI_MODEL');
    model.value = 'missing-model';
    model.dispatchEvent(new Event('input', { bubbles: true }));
    await click('Save settings');
    expect(document.querySelector('[data-field="OPENAI_MODEL"]')?.textContent).toContain('Model is not available');
  });

  it('saves a parsed config file with its mtime precondition', async () => {
    await render();
    await click('Config files');
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="config-json"]');
    if (!textarea) throw new Error('config JSON textarea did not render');
    textarea.value = JSON.stringify({ groups: [{ id: 'test-group' }] });
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await click('Save config file');
    expect(apiMocks.putConfigFile).toHaveBeenCalledWith('groups', {
      mtimeMs: 21,
      sha256: 'groups-hash',
      value: { groups: [{ id: 'test-group' }] },
    });
  });

  it('renders streamed apply output and the terminal session message', async () => {
    await render();
    await click('Apply');
    await click('Apply changes');
    expect(document.querySelector('.apply-console')?.textContent).toContain('started');
    expect(document.body.textContent).toContain('Applied — the config service has exited');
  });

  it('previews and confirms an imported redacted bundle', async () => {
    await render();
    await click('Transfer');
    const fileInput = document.querySelector<HTMLInputElement>('input[name="import-bundle"]');
    if (!fileInput) throw new Error('import file input did not render');
    const file = new File([JSON.stringify({ format: 'garbanzo-config-bundle-v1', files: {} })], 'bundle.json', { type: 'application/json' });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(document.body.textContent).toContain('OPENAI_API_KEY=<redacted>');
    await click('Confirm import');
    expect(apiMocks.confirmImport).toHaveBeenCalledWith('stage-1');
    expect(document.body.textContent).toContain('Changed files');
  });
});
