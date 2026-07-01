process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalLoginMode = process.env.WHATSAPP_LOGIN_MODE;
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

async function importConfigWithLoginMode(mode: string | undefined) {
  vi.resetModules();
  if (mode === undefined) {
    delete process.env.WHATSAPP_LOGIN_MODE;
  } else {
    process.env.WHATSAPP_LOGIN_MODE = mode;
  }

  return import('../src/utils/config.js');
}

describe('WHATSAPP_LOGIN_MODE config', () => {
  afterEach(() => {
    vi.resetModules();
    if (originalLoginMode === undefined) {
      delete process.env.WHATSAPP_LOGIN_MODE;
    } else {
      process.env.WHATSAPP_LOGIN_MODE = originalLoginMode;
    }
    exitSpy.mockClear();
    errorSpy.mockClear();
  });

  it('defaults to web', async () => {
    const { config } = await importConfigWithLoginMode(undefined);

    expect(config.WHATSAPP_LOGIN_MODE).toBe('web');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid value', async () => {
    await expect(importConfigWithLoginMode('invalid')).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid environment variables'));
  });

  it('honors a valid explicit terminal value', async () => {
    const { config } = await importConfigWithLoginMode('terminal');

    expect(config.WHATSAPP_LOGIN_MODE).toBe('terminal');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
