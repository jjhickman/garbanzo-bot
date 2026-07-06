import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEnvLayers } from '../src/utils/config/shared.js';

const tempDirs: string[] = [];

async function makeEnvDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'garbanzo-env-layering-'));
  tempDirs.push(dir);

  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents);
  }

  return dir;
}

describe('config env layering', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('loads the shared base env file', async () => {
    const baseDir = await makeEnvDir({
      '.env': 'AI_PROVIDER_ORDER=openrouter\nOPENROUTER_API_KEY=shared_key\n',
    });
    const env: NodeJS.ProcessEnv = {};

    const result = applyEnvLayers({ baseDir, env, realEnv: {} });

    expect(env.AI_PROVIDER_ORDER).toBe('openrouter');
    expect(env.OPENROUTER_API_KEY).toBe('shared_key');
    expect(result.loadedEnvFiles).toEqual([join(baseDir, '.env')]);
  });

  it('loads the platform file after the base file with platform values overriding shared values', async () => {
    const baseDir = await makeEnvDir({
      '.env': 'MESSAGING_PLATFORM=discord\nQDRANT_COLLECTION=shared_memory\n',
      '.env.discord': 'QDRANT_COLLECTION=discord_memory\nDISCORD_BOT_TOKEN=test_token\n',
    });
    const env: NodeJS.ProcessEnv = {};

    const result = applyEnvLayers({ baseDir, env, realEnv: {} });

    expect(env.MESSAGING_PLATFORM).toBe('discord');
    expect(env.QDRANT_COLLECTION).toBe('discord_memory');
    expect(env.DISCORD_BOT_TOKEN).toBe('test_token');
    expect(result.loadedEnvFiles).toEqual([join(baseDir, '.env'), join(baseDir, '.env.discord')]);
  });

  it('preserves real environment values over base and platform files', async () => {
    const baseDir = await makeEnvDir({
      '.env': 'MESSAGING_PLATFORM=whatsapp\nOPENROUTER_API_KEY=shared_key\nOWNER_JID=shared_owner@s.whatsapp.net\n',
      '.env.whatsapp': 'OPENROUTER_API_KEY=platform_key\nOWNER_JID=platform_owner@s.whatsapp.net\n',
    });
    const realEnv: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: 'real_key',
      OWNER_JID: 'real_owner@s.whatsapp.net',
    };
    const env: NodeJS.ProcessEnv = { ...realEnv };

    applyEnvLayers({ baseDir, env, realEnv });

    expect(env.MESSAGING_PLATFORM).toBe('whatsapp');
    expect(env.OPENROUTER_API_KEY).toBe('real_key');
    expect(env.OWNER_JID).toBe('real_owner@s.whatsapp.net');
  });

  it('keeps base values when the platform file is missing', async () => {
    const baseDir = await makeEnvDir({
      '.env': 'MESSAGING_PLATFORM=whatsapp\nAI_PROVIDER_ORDER=openrouter\n',
    });
    const env: NodeJS.ProcessEnv = {};

    const result = applyEnvLayers({ baseDir, env, realEnv: {} });

    expect(env.MESSAGING_PLATFORM).toBe('whatsapp');
    expect(env.AI_PROVIDER_ORDER).toBe('openrouter');
    expect(result.loadedEnvFiles).toEqual([join(baseDir, '.env')]);
  });

  it('derives the platform from the base file when the real env does not set it', async () => {
    const baseDir = await makeEnvDir({
      '.env': 'MESSAGING_PLATFORM=whatsapp\nOWNER_JID=shared_owner@s.whatsapp.net\n',
      '.env.whatsapp': 'OWNER_JID=platform_owner@s.whatsapp.net\n',
    });
    const env: NodeJS.ProcessEnv = {};

    applyEnvLayers({ baseDir, env, realEnv: {} });

    expect(env.MESSAGING_PLATFORM).toBe('whatsapp');
    expect(env.OWNER_JID).toBe('platform_owner@s.whatsapp.net');
  });
});
