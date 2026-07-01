#!/usr/bin/env node
/**
 * Interactive "Sign in with ChatGPT" login for OpenAI OAuth mode (EXPERIMENTAL).
 *
 * Runs the Codex PKCE OAuth flow and writes tokens to data/openai-oauth.json
 * (mode 0600) for OPENAI_AUTH_MODE=oauth. OpenAI pins the redirect URI to
 * http://localhost:1455/auth/callback, so it captures the authorization code
 * two ways at once and uses whichever completes first:
 *
 *   1. A local callback server on 127.0.0.1:1455 — works when the browser runs
 *      on the same host (or over an `ssh -L 1455:localhost:1455` tunnel).
 *   2. A paste prompt — for headless/remote hosts (e.g. a Raspberry Pi over SSH):
 *      sign in from any browser, then paste the dead `localhost:1455/...` URL you
 *      land on (or just the code) back into this terminal. No tunnel needed.
 *
 * Pass --manual (or --no-browser) to skip the local server and only paste.
 *
 * This is unofficial and against OpenAI's ToS; the bot always falls back to
 * other providers if it fails. Constants here mirror src/ai/openai-oauth.ts.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
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

/**
 * Extract the authorization code from whatever the user pasted: a full redirect
 * URL, a bare `code=...&state=...` query string, or just the code itself.
 * Validates the CSRF `state` when it is present. Returns { code } or null for
 * empty input; throws on an OAuth error, a missing code, or a state mismatch.
 */
export function parseCallbackInput(input, expectedState) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;

  const looksStructured = trimmed.includes('://') || trimmed.includes('code=') || trimmed.startsWith('?');
  if (!looksStructured) {
    // A bare code with no surrounding query — no state to validate.
    return { code: trimmed, stateChecked: false };
  }

  const base = trimmed.includes('://') ? trimmed : `http://localhost/?${trimmed.replace(/^\?/, '')}`;
  const url = new URL(base);
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Authorization error: ${error}`);

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code) throw new Error('No "code" found — paste the full redirect URL from your browser address bar.');
  if (returnedState !== expectedState) {
    throw new Error('State mismatch — that URL is from a different login attempt. Aborting for safety.');
  }
  return { code, stateChecked: true };
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
  // `mode` only applies when the file is created; chmod ensures a pre-existing
  // (possibly world/group-readable) token file is tightened on every re-login.
  await chmod(TOKEN_PATH, 0o600);
}

/**
 * Race the local callback server against a stdin paste; return the authorization
 * code from whichever arrives first. In --manual mode the server is skipped.
 */
function captureAuthCode(authorizeUrl, state, { manual }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let server = null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const cleanup = () => {
      clearTimeout(timer);
      try { rl.close(); } catch { /* ignore */ }
      try { server?.close(); } catch { /* ignore */ }
    };
    const succeed = (code) => { if (settled) return; settled = true; cleanup(); resolvePromise(code); };
    const fail = (err) => { if (settled) return; settled = true; cleanup(); rejectPromise(err); };

    const timer = setTimeout(
      () => fail(new Error(`Timed out after ${CALLBACK_TIMEOUT_MS / 1000}s waiting for the callback or a pasted code.`)),
      CALLBACK_TIMEOUT_MS,
    );

    // Paste path — always available.
    rl.on('line', (line) => {
      try {
        const parsed = parseCallbackInput(line, state);
        if (parsed) succeed(parsed.code);
      } catch (err) {
        // Non-fatal: let the user try again (or wait for the browser callback).
        console.error(`   ⚠️ ${err.message} Try pasting again, or press Ctrl+C to abort.`);
      }
    });

    const printInstructions = ({ serverUp }) => {
      console.log('\n🫘 Sign in with ChatGPT to link OpenAI OAuth (experimental).\n');
      console.log('1. Open this URL in a browser and sign in:\n');
      console.log(`   ${authorizeUrl}\n`);
      if (serverUp) {
        console.log(`2. If the browser is on THIS machine (or an "ssh -L ${REDIRECT_PORT}:localhost:${REDIRECT_PORT}" tunnel),`);
        console.log('   login completes automatically — you can ignore the prompt below.\n');
      }
      console.log('   Otherwise (remote/headless host): after signing in your browser will land on a');
      console.log(`   "can't reach localhost:${REDIRECT_PORT}" page. Copy that page's full URL from the address`);
      console.log('   bar and paste it here, then press Enter:');
      rl.setPrompt('\n   redirect URL (or code) > ');
      rl.prompt();
    };

    if (manual) {
      printInstructions({ serverUp: false });
      return;
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      // Decide success/failure (including the CSRF state check) BEFORE rendering,
      // so a wrong-state callback never shows a false "linked" success page.
      let failure = null;
      if (error || !code) {
        failure = error ?? 'no authorization code returned';
      } else if (returnedState !== state) {
        failure = 'State mismatch — aborting for safety.';
      }

      res.writeHead(failure ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">` +
          (failure
            ? `<h1>Login failed</h1><p>${failure}</p>`
            : `<h1>Garbanzo is linked to ChatGPT ✓</h1><p>You can close this tab and return to the terminal.</p>`) +
          `</body>`,
      );

      if (failure) fail(new Error(error || !code ? `Authorization failed: ${error ?? 'no code'}` : failure));
      else succeed(code);
    });

    // If the local server can't bind (port in use, sandbox, no permission), don't
    // abort — fall back to paste-only so remote/headless logins still work.
    server.on('error', (err) => {
      console.error(`   ⚠️ Local callback server unavailable (${err.code ?? err.message}); use the paste option.`);
      server = null;
      printInstructions({ serverUp: false });
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      printInstructions({ serverUp: true });
      openBrowser(authorizeUrl);
    });
  });
}

async function main() {
  const manual = process.argv.slice(2).some((a) => a === '--manual' || a === '--no-browser' || a === '--paste');

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

  const code = await captureAuthCode(authorizeUrl.toString(), state, { manual });

  const tokens = await exchangeCode(code, codeVerifier);
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

// Only run the flow when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n❌ OpenAI login failed: ${err.message}\n`);
    process.exit(1);
  });
}
