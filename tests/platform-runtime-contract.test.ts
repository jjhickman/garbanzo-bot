import { describe, it, expect } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

describe('PlatformRuntime contract', () => {
  it('every runtime factory exposes start() and stop()', async () => {
    const { createDiscordRuntime } = await import('../src/platforms/discord/runtime.js');
    const { createSlackRuntime } = await import('../src/platforms/slack/runtime.js');
    const { createTeamsRuntime } = await import('../src/platforms/teams/runtime.js');
    for (const make of [createDiscordRuntime, createSlackRuntime, createTeamsRuntime]) {
      const rt = make();
      expect(typeof rt.start).toBe('function');
      expect(typeof rt.stop).toBe('function');
      await expect(rt.stop()).resolves.toBeUndefined();
    }
  });
});
