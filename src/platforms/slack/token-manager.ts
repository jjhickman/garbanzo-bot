import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { logger } from '../../middleware/logger.js';
import { PROJECT_ROOT } from '../../utils/config.js';

export interface SlackTokenProvider {
  getToken(): Promise<string>;
  forceRefresh(): Promise<void>;
}

interface SlackTokenState {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

interface SlackRotationResponse {
  ok: boolean;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

interface SlackTokenManagerParams {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  stateFile: string;
  minBufferMinutes: number;
}

function normalizeStateFilePath(inputPath: string): string {
  if (inputPath.startsWith('/')) return inputPath;
  return resolve(PROJECT_ROOT, inputPath);
}

function shouldRefresh(expiresAtMs: number | undefined, minBufferMinutes: number): boolean {
  if (!expiresAtMs) return false;
  const bufferMs = minBufferMinutes * 60_000;
  return Date.now() >= (expiresAtMs - bufferMs);
}

async function loadState(path: string): Promise<SlackTokenState | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SlackTokenState>;
    if (!parsed.accessToken || typeof parsed.accessToken !== 'string') return null;

    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
      expiresAtMs: typeof parsed.expiresAtMs === 'number' ? parsed.expiresAtMs : undefined,
    };
  } catch {
    return null;
  }
}

async function saveState(path: string, state: SlackTokenState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err, path }, 'Unable to persist Slack token state file');
  }
}

export function createSlackTokenProvider(params: SlackTokenManagerParams): SlackTokenProvider {
  const stateFile = normalizeStateFilePath(params.stateFile);

  let state: SlackTokenState = {
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
  };

  let initPromise: Promise<void> | null = null;
  let refreshPromise: Promise<void> | null = null;

  const rotationEnabled = Boolean(
    params.clientId && params.clientSecret && params.refreshToken,
  );

  async function initializeFromDisk(): Promise<void> {
    const stored = await loadState(stateFile);
    if (!stored) return;

    state = {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken ?? state.refreshToken,
      expiresAtMs: stored.expiresAtMs,
    };
  }

  async function rotateTokens(): Promise<void> {
    if (!rotationEnabled) return;

    const refreshToken = state.refreshToken ?? params.refreshToken;
    if (!refreshToken || !params.clientId || !params.clientSecret) {
      throw new Error('Slack token rotation is enabled but missing refresh credentials');
    }

    const body = new URLSearchParams();
    body.set('client_id', params.clientId);
    body.set('client_secret', params.clientSecret);
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', refreshToken);

    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const json = await response.json() as SlackRotationResponse;
    if (!response.ok || !json.ok || !json.access_token || !json.refresh_token || !json.expires_in) {
      throw new Error(`Slack token refresh failed: ${json.error ?? response.status}`);
    }

    state = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAtMs: Date.now() + (json.expires_in * 1000),
    };

    await saveState(stateFile, state);

    logger.info(
      {
        expiresInSeconds: json.expires_in,
        stateFile,
      },
      'Slack access token refreshed',
    );
  }

  async function ensureReady(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        await initializeFromDisk();

        // If rotation is configured and there is no known expiry, refresh once
        // on boot to ensure we have deterministic expiration tracking.
        if (rotationEnabled && !state.expiresAtMs) {
          await rotateTokens();
        }
      })();
    }

    await initPromise;

    if (rotationEnabled && shouldRefresh(state.expiresAtMs, params.minBufferMinutes)) {
      await forceRefresh();
    }
  }

  async function forceRefresh(): Promise<void> {
    if (!rotationEnabled) return;
    if (!refreshPromise) {
      refreshPromise = rotateTokens().finally(() => {
        refreshPromise = null;
      });
    }

    await refreshPromise;
  }

  return {
    async getToken(): Promise<string> {
      await ensureReady();
      return state.accessToken;
    },

    async forceRefresh(): Promise<void> {
      await forceRefresh();
    },
  };
}
