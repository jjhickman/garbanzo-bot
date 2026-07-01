// AI-layer test: config is imported at module load, so run under the standard
// test env prefix (see cloud-call.test.ts note).
import { afterEach, describe, expect, it, vi } from 'vitest';

// In-memory backing for the mocked token file (hoisted so the mock factories can see it).
const store = vi.hoisted(() => ({ file: null as string | null }));

vi.mock('node:fs/promises', () => ({
  readFile: async (): Promise<string> => {
    if (store.file === null) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return store.file;
  },
  writeFile: async (_path: unknown, data: unknown): Promise<void> => {
    store.file = String(data);
  },
  chmod: async (): Promise<void> => undefined,
}));

vi.mock('node:fs', () => ({ existsSync: (): boolean => store.file !== null }));

import {
  accountIdFromIdToken,
  getOpenAIAccessToken,
  openAITokenFileExists,
  readTokenStore,
  writeTokenStore,
  OPENAI_OAUTH_REFRESH_SKEW_MS,
  type OpenAITokenStore,
} from '../src/ai/openai-oauth.js';

function makeStore(overrides: Partial<OpenAITokenStore> = {}): OpenAITokenStore {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    id_token: 'id-1',
    account_id: 'acc-1',
    expires_at: 10_000_000_000_000, // far future
    ...overrides,
  };
}

function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('openai-oauth token store', () => {
  afterEach(() => {
    store.file = null;
    vi.restoreAllMocks();
  });

  it('round-trips the token store through read/write', async () => {
    expect(openAITokenFileExists()).toBe(false);
    await writeTokenStore(makeStore());
    expect(openAITokenFileExists()).toBe(true);
    expect(await readTokenStore()).toEqual(makeStore());
  });

  it('returns null when the token file is missing or malformed', async () => {
    expect(await readTokenStore()).toBeNull();
    store.file = '{ not valid json';
    expect(await readTokenStore()).toBeNull();
    store.file = JSON.stringify({ access_token: 'x' }); // missing required fields
    expect(await readTokenStore()).toBeNull();
  });

  it('throws when not logged in', async () => {
    await expect(getOpenAIAccessToken()).rejects.toThrow(/not logged in/);
  });

  it('returns the stored token without refreshing when far from expiry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await writeTokenStore(makeStore({ expires_at: 10_000_000_000_000 }));

    const token = await getOpenAIAccessToken(1_000);
    expect(token.accessToken).toBe('access-1');
    expect(token.accountId).toBe('acc-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes and persists a new token when within the expiry skew', async () => {
    const now = 1_000_000;
    await writeTokenStore(makeStore({ access_token: 'old', refresh_token: 'r-old', expires_at: now + OPENAI_OAUTH_REFRESH_SKEW_MS - 1 }));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'new-access', refresh_token: 'r-new', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const token = await getOpenAIAccessToken(now);
    expect(token.accessToken).toBe('new-access');

    // Persisted: subsequent reads see the refreshed token + rotated refresh token.
    const persisted = await readTokenStore();
    expect(persisted?.access_token).toBe('new-access');
    expect(persisted?.refresh_token).toBe('r-new');
    expect(persisted?.expires_at).toBeGreaterThan(now);
  });

  it('surfaces refresh failures so the caller can fall back', async () => {
    const now = 1_000_000;
    await writeTokenStore(makeStore({ expires_at: now })); // already expired

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('invalid_grant', { status: 400, headers: { 'content-type': 'text/plain' } }),
    );

    await expect(getOpenAIAccessToken(now)).rejects.toThrow(/token refresh failed 400/);
  });

  it('extracts the account id from an id_token JWT', () => {
    expect(accountIdFromIdToken(jwtWith({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_xyz' } }))).toBe('acc_xyz');
    expect(accountIdFromIdToken(jwtWith({ account_id: 'acc_top' }))).toBe('acc_top');
    expect(accountIdFromIdToken('not-a-jwt')).toBeNull();
  });
});
