/**
 * OpenAI "Sign in with ChatGPT" OAuth token lifecycle (EXPERIMENTAL, ToS-grey).
 *
 * This reuses the public Codex OAuth client to obtain a ChatGPT-subscription
 * access token and calls OpenAI's private ChatGPT backend. It is unofficial,
 * against OpenAI's ToS, and may break without notice — the runtime path is
 * always fallback-protected (see router.ts / chatgpt.ts). This module owns the
 * token store + refresh; the interactive login lives in scripts/openai-login.mjs.
 *
 * Endpoints/claims below were captured from community implementations of the
 * Codex flow and have NOT been validated here against a live token.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { PROJECT_ROOT } from '../utils/config.js';
import { logger } from '../middleware/logger.js';

export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OPENAI_OAUTH_SCOPE = 'openid profile email offline_access';
/** Refresh when the token is within this window of expiry. */
export const OPENAI_OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;

export const OPENAI_TOKEN_PATH = resolve(PROJECT_ROOT, 'data/openai-oauth.json');

const TokenStoreSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().optional(),
  account_id: z.string().optional(),
  /** Epoch milliseconds. */
  expires_at: z.number(),
});

export type OpenAITokenStore = z.infer<typeof TokenStoreSchema>;

/** Sync existence check used by provider-configured gates. */
export function openAITokenFileExists(): boolean {
  return existsSync(OPENAI_TOKEN_PATH);
}

export async function readTokenStore(): Promise<OpenAITokenStore | null> {
  try {
    const raw = await readFile(OPENAI_TOKEN_PATH, 'utf-8');
    const parsed = TokenStoreSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn('OpenAI OAuth token file is malformed; treating as logged out');
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export async function writeTokenStore(store: OpenAITokenStore): Promise<void> {
  await writeFile(OPENAI_TOKEN_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  // Ensure 0600 even if the file pre-existed with looser perms.
  try {
    await chmod(OPENAI_TOKEN_PATH, 0o600);
  } catch {
    /* best effort — some platforms/filesystems don't support chmod */
  }
}

/**
 * Extract the ChatGPT account id from the id_token JWT payload. The exact claim
 * path is unverified, so several known shapes are attempted defensively.
 */
export function accountIdFromIdToken(idToken: string): string | null {
  const parts = idToken.split('.');
  if (parts.length < 2 || !parts[1]) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    const candidate =
      (auth?.chatgpt_account_id as string | undefined) ??
      (auth?.organization_id as string | undefined) ??
      (payload.account_id as string | undefined) ??
      (payload.chatgpt_account_id as string | undefined);
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.number().optional(),
});

async function refreshAccessToken(store: OpenAITokenStore): Promise<OpenAITokenStore> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OPENAI_OAUTH_CLIENT_ID,
    refresh_token: store.refresh_token,
    scope: OPENAI_OAUTH_SCOPE,
  });

  const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI token refresh failed ${response.status}: ${text}`);
  }

  const data = TokenResponseSchema.parse(await response.json());
  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  const idToken = data.id_token ?? store.id_token;

  const next: OpenAITokenStore = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? store.refresh_token,
    id_token: idToken,
    account_id: (idToken ? accountIdFromIdToken(idToken) : null) ?? store.account_id,
    expires_at: Date.now() + expiresInMs,
  };

  await writeTokenStore(next);
  return next;
}

export interface OpenAIAccessToken {
  accessToken: string;
  accountId: string | null;
}

/**
 * Return a valid OpenAI access token, refreshing proactively when it is within
 * the skew window of expiry. Throws when not logged in or when a refresh fails —
 * callers must treat that as a provider failure and fall back.
 */
export async function getOpenAIAccessToken(now: number = Date.now()): Promise<OpenAIAccessToken> {
  const store = await readTokenStore();
  if (!store) {
    throw new Error('OpenAI OAuth is not logged in (run: npm run openai:login)');
  }

  let current = store;
  if (now >= current.expires_at - OPENAI_OAUTH_REFRESH_SKEW_MS) {
    logger.info('Refreshing OpenAI OAuth access token');
    current = await refreshAccessToken(current);
  }

  const accountId = current.account_id ?? (current.id_token ? accountIdFromIdToken(current.id_token) : null);
  return { accessToken: current.access_token, accountId };
}
