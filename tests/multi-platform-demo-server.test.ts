import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { createSlackDemoServer, renderDemoPageHtml } from '../src/platforms/slack/demo-server.js';

const servers: Array<ReturnType<typeof createSlackDemoServer>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

async function startServer(): Promise<{ baseUrl: string }> {
  const server = createSlackDemoServer(
    { host: '127.0.0.1', port: 0 },
    { turnstileEnabled: false },
  );
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server did not start on a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe('Unified demo server', () => {
  it('exposes health endpoints for both platform modes', async () => {
    const { baseUrl } = await startServer();

    const slackRes = await fetch(`${baseUrl}/slack/demo`);
    expect(slackRes.status).toBe(200);
    const slackBody = await slackRes.json() as {
      ok?: boolean;
      platform?: string;
      inference?: { primaryModel?: string; primaryProvider?: string };
    };
    expect(slackBody.ok).toBe(true);
    expect(slackBody.platform).toBe('slack');
    expect(typeof slackBody.inference?.primaryModel).toBe('string');
    expect(typeof slackBody.inference?.primaryProvider).toBe('string');

    const discordRes = await fetch(`${baseUrl}/discord/demo`);
    expect(discordRes.status).toBe(200);
    const discordBody = await discordRes.json() as {
      ok?: boolean;
      platform?: string;
      inference?: { primaryModel?: string; primaryProvider?: string };
    };
    expect(discordBody.ok).toBe(true);
    expect(discordBody.platform).toBe('discord');
    expect(typeof discordBody.inference?.primaryModel).toBe('string');
    expect(typeof discordBody.inference?.primaryProvider).toBe('string');
  });

  it('routes chat payload through both platform modes via one endpoint', async () => {
    const { baseUrl } = await startServer();

    const slackRes = await fetch(`${baseUrl}/demo/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'slack', text: '@garbanzo !help' }),
    });
    expect(slackRes.status).toBe(200);
    const slackBody = await slackRes.json() as {
      ok?: boolean;
      platform?: string;
      outbox?: unknown[];
      inference?: { primaryModel?: string; primaryProvider?: string; costProfile?: string };
    };
    expect(slackBody.ok).toBe(true);
    expect(slackBody.platform).toBe('slack');
    expect(Array.isArray(slackBody.outbox)).toBe(true);
    expect((slackBody.outbox ?? []).length).toBeGreaterThan(0);
    expect(typeof slackBody.inference?.primaryModel).toBe('string');
    expect(typeof slackBody.inference?.primaryProvider).toBe('string');
    expect(typeof slackBody.inference?.costProfile).toBe('string');

    const discordRes = await fetch(`${baseUrl}/demo/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'discord', text: '@garbanzo !help' }),
    });
    expect(discordRes.status).toBe(200);
    const discordBody = await discordRes.json() as {
      ok?: boolean;
      platform?: string;
      outbox?: unknown[];
      inference?: { primaryModel?: string; primaryProvider?: string; costProfile?: string };
    };
    expect(discordBody.ok).toBe(true);
    expect(discordBody.platform).toBe('discord');
    expect(Array.isArray(discordBody.outbox)).toBe(true);
    expect((discordBody.outbox ?? []).length).toBeGreaterThan(0);
    expect(typeof discordBody.inference?.primaryModel).toBe('string');
    expect(typeof discordBody.inference?.primaryProvider).toBe('string');
    expect(typeof discordBody.inference?.costProfile).toBe('string');
  });
});

describe('Demo UI generation', () => {
  it('generates browser-parseable inline script and platform controls', () => {
    const html = renderDemoPageHtml({
      turnstileEnabled: false,
      turnstileSiteKey: '',
      demoModel: {
        providerOrder: ['openrouter', 'openai'],
        primaryProvider: 'openrouter',
        primaryModel: 'openai/gpt-4.1-mini',
        modelsByProvider: {
          openrouter: 'openai/gpt-4.1-mini',
          openai: 'gpt-4.1-mini',
        },
        costProfile: 'cost-optimized',
      },
    });

    expect(html).toContain('data-platform="slack"');
    expect(html).toContain('data-platform="discord"');
    expect(html).toContain("fetch('/demo/chat'");
    expect(html).toContain('Model transparency');
    expect(html).toContain('openai/gpt-4.1-mini');

    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch?.[1] ?? '';

    expect(() => new Function(script)).not.toThrow();
  });
});
