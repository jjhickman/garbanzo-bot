// Security: Google/Gemini API keys must ride in headers, never the URL query
// string (where they leak into request logs/proxies). Runs under the standard
// test env prefix (config imported transitively).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProviderRequest } from '../src/ai/cloud-providers.js';
import { handleWeather } from '../src/features/weather.js';
import { handleVenues } from '../src/features/venues.js';
import { config } from '../src/utils/config.js';

const originalGoogle = config.GOOGLE_API_KEY;
const originalGemini = config.GEMINI_API_KEY;

afterEach(() => {
  config.GOOGLE_API_KEY = originalGoogle;
  config.GEMINI_API_KEY = originalGemini;
  vi.restoreAllMocks();
});

function zeroResults(): Response {
  return new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function assertKeyInHeaderNotUrl(spy: ReturnType<typeof vi.spyOn>, expectedKey: string): void {
  expect(spy).toHaveBeenCalled();
  for (const call of spy.mock.calls as unknown as Array<[string, RequestInit]>) {
    const [url, init] = call;
    expect(String(url)).not.toContain('key=');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Goog-Api-Key'] ?? headers['x-goog-api-key']).toBe(expectedKey);
  }
}

describe('Google/Gemini API keys are sent in headers, not URLs', () => {
  it('gemini request carries the key in x-goog-api-key, not the endpoint', () => {
    config.GEMINI_API_KEY = 'test-gemini-key';
    const req = buildProviderRequest('gemini', 'sys', 'hi');
    expect(req).not.toBeNull();
    expect(req?.endpoint).not.toContain('test-gemini-key');
    expect(req?.endpoint).not.toContain('key=');
    expect(req?.headers['x-goog-api-key']).toBe('test-gemini-key');
  });

  it('weather sends the Google key in a header', async () => {
    config.GOOGLE_API_KEY = 'test-google-key';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(zeroResults());

    await handleWeather('weather in cambridge').catch(() => undefined);

    assertKeyInHeaderNotUrl(spy, 'test-google-key');
  });

  it('venues sends the Google key in a header', async () => {
    config.GOOGLE_API_KEY = 'test-google-key';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(zeroResults());

    await handleVenues('coffee').catch(() => undefined);

    assertKeyInHeaderNotUrl(spy, 'test-google-key');
  });
});
