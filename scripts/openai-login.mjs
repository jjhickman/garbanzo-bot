#!/usr/bin/env node
/**
 * Interactive "Sign in with ChatGPT" login for OpenAI OAuth mode (EXPERIMENTAL).
 *
 * Runs the Codex PKCE OAuth flow: opens the browser, captures the callback on
 * http://localhost:1455/auth/callback, exchanges the code for tokens, and writes
 * them to data/openai-oauth.json (mode 0600) for OPENAI_AUTH_MODE=oauth.
 *
 * This is unofficial and against OpenAI's ToS; the bot always falls back to
 * other providers if it fails. Constants here mirror src/ai/openai-oauth.ts.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const SCOPE = 'openid profile email offline_access';
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const TOKEN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'openai-oauth.json');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function accountIdFromIdToken(idToken) {
  const parts = String(idToken ?? '').split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    const auth = payload['https://api.openai.com/auth'] ?? {};
    return auth.chatgpt_account_id ?? auth.organization_id ?? payload.account_id ?? payload.chatgpt_account_id ?? null;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* fall back to the printed URL */
  }
}

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function writeTokenStore(store) {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const codeVerifier = base64url(randomBytes(64));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = base64url(randomBytes(24));

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'garbanzo',
  }).toString();

  const result = await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      res.writeHead(error || !code ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">` +
          (error || !code
            ? `<h1>Login failed</h1><p>${error ?? 'no authorization code returned'}</p>`
            : `<h1>Garbanzo is linked to ChatGPT ✓</h1><p>You can close this tab and return to the terminal.</p>`) +
          `</body>`,
      );

      clearTimeout(timer);
      server.close();

      if (error || !code) {
        rejectPromise(new Error(`Authorization failed: ${error ?? 'no code'}`));
      } else if (returnedState !== state) {
        rejectPromise(new Error('State mismatch — aborting for safety.'));
      } else {
        resolvePromise(code);
      }
    });

    const timer = setTimeout(() => {
      server.close();
      rejectPromise(new Error(`Timed out waiting for the browser callback after ${CALLBACK_TIMEOUT_MS / 1000}s.`));
    }, CALLBACK_TIMEOUT_MS);

    server.on('error', rejectPromise);
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log('\n🫘 Opening your browser to sign in with ChatGPT...');
      console.log(`If it does not open, paste this URL into your browser:\n\n${authorizeUrl.toString()}\n`);
      openBrowser(authorizeUrl.toString());
    });
  });

  const tokens = await exchangeCode(result, codeVerifier);
  const expiresInMs = (Number(tokens.expires_in) || 3600) * 1000;
  const store = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    account_id: accountIdFromIdToken(tokens.id_token),
    expires_at: Date.now() + expiresInMs,
  };

  if (!store.access_token || !store.refresh_token) {
    throw new Error('Token response did not include access_token/refresh_token.');
  }

  await writeTokenStore(store);
  console.log(`\n✅ Saved OpenAI OAuth tokens to ${TOKEN_PATH}`);
  console.log('   Set OPENAI_AUTH_MODE=oauth and add "openai" to AI_PROVIDER_ORDER to use it.');
  console.log('   Note: this path is experimental and against OpenAI ToS; the bot falls back if it breaks.\n');
}

main().catch((err) => {
  console.error(`\n❌ OpenAI login failed: ${err.message}\n`);
  process.exit(1);
});
