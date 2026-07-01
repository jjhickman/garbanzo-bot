// AI-layer tests statically import config (via cloud-call.ts), so they run under
// the standard test env prefix like the sibling gemini/bedrock tests — a
// self-seed preamble can't help because ESM evaluates imports first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callCloudProvider, __resetCloudBreakers } from '../src/ai/cloud-call.js';

const failing = () => async (): Promise<string> => {
  throw new Error('boom');
};

describe('callCloudProvider', () => {
  beforeEach(() => {
    __resetCloudBreakers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('trims text and returns a CloudResponse on success', async () => {
    const res = await callCloudProvider({ provider: 'openai', model: 'gpt', perform: async () => '  hi  ' });
    expect(res).toEqual({ text: 'hi', provider: 'openai', model: 'gpt' });
  });

  it('throws on an empty response', async () => {
    await expect(
      callCloudProvider({ provider: 'openai', model: 'gpt', perform: async () => '   ' }),
    ).rejects.toThrow(/empty response/);
  });

  it('rethrows the underlying error below the failure threshold', async () => {
    await expect(callCloudProvider({ provider: 'gemini', model: 'g', perform: failing() })).rejects.toThrow('boom');
    await expect(callCloudProvider({ provider: 'gemini', model: 'g', perform: failing() })).rejects.toThrow('boom');
  });

  it('opens the breaker after 3 consecutive failures', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(callCloudProvider({ provider: 'anthropic', model: 'c', perform: failing() })).rejects.toThrow('boom');
    }
    // 4th call is short-circuited by the open breaker, even though perform would succeed.
    await expect(
      callCloudProvider({ provider: 'anthropic', model: 'c', perform: async () => 'ok' }),
    ).rejects.toThrow(/circuit breaker open/);
  });

  it('isolates breakers per provider', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(callCloudProvider({ provider: 'openai', model: 'gpt', perform: failing() })).rejects.toThrow('boom');
    }
    // openai is tripped; bedrock is unaffected.
    const res = await callCloudProvider({ provider: 'bedrock', model: 'b', perform: async () => 'ok' });
    expect(res.text).toBe('ok');
  });

  it('resets the failure count after a success', async () => {
    await expect(callCloudProvider({ provider: 'openrouter', model: 'o', perform: failing() })).rejects.toThrow('boom');
    await expect(callCloudProvider({ provider: 'openrouter', model: 'o', perform: failing() })).rejects.toThrow('boom');
    // Success resets the count to 0.
    await expect(callCloudProvider({ provider: 'openrouter', model: 'o', perform: async () => 'ok' })).resolves.toMatchObject({ text: 'ok' });
    // Two more failures should therefore NOT open the breaker.
    await expect(callCloudProvider({ provider: 'openrouter', model: 'o', perform: failing() })).rejects.toThrow('boom');
    await expect(callCloudProvider({ provider: 'openrouter', model: 'o', perform: failing() })).rejects.toThrow('boom');
    await expect(callCloudProvider({ provider: 'openrouter', model: 'o', perform: async () => 'y' })).resolves.toMatchObject({ text: 'y' });
  });

  it('aborts perform via the timeout signal', async () => {
    let sawAbort = false;
    const perform = (signal: AbortSignal): Promise<string> =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
      });

    await expect(callCloudProvider({ provider: 'openai', model: 'gpt', timeoutMs: 5, perform })).rejects.toThrow('aborted');
    expect(sawAbort).toBe(true);
  });
});
