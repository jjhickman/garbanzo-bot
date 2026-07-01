# Plan 2 — WhatsApp Browser Login (Phase 2)

Design: docs/superpowers/specs/2026-06-27-whatsapp-login-openai-oauth-hardening-design.md (§4 Phase 2)
Branch: codex/plan-garbanzobot-hardening → PR #164
Base before Task 1: e3a4c4b

## Goal

Replace terminal-only WhatsApp QR linking with a token-gated browser login page served
on the existing health server. The page offers two paths — scan a live-updating QR (via
SSE) or request an 8-char pairing code — and shows "Linked ✓" on success. Terminal QR
becomes opt-in. QR rotation within one connection attempt is NOT a reconnect and is not a
bot-flag driver (that was Phase 1), so the browser may refresh the QR freely.

## Global Constraints (binding — reviewers copy verbatim)

- **ESM discipline:** every relative import uses an explicit `.js` extension.
- **Test env:** every new/modified test file self-seeds required env at the very top,
  before any app-module import:
  ```ts
  process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
  process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
  process.env.AI_PROVIDER_ORDER ??= 'openrouter';
  ```
  Done criterion: named test files pass with NO env prefix on `npx vitest run <files>`.
- **Localhost default:** login + metrics routes are only as exposed as `HEALTH_BIND_HOST`
  (default `127.0.0.1`). No route binds a new port; everything mounts on the health server.
- **Token gate:** all `/whatsapp/login*` routes AND `/metrics` require `?token=<T>` where
  `T` is the runtime login token; mismatch/absent → HTTP 401. Token comparison must be
  length-safe constant-time (`crypto.timingSafeEqual` with a length guard).
- **Login mode:** `WHATSAPP_LOGIN_MODE` ∈ {`web`,`terminal`,`both`}, default `web`.
  `web` publishes QR only to the login store; `terminal` only to the terminal; `both` both.
- **Single-socket invariant (from Phase 1) is not weakened:** the login store holds a
  reference to the *current* socket only; it never creates or retains extra sockets.
- **No secrets in logs:** never log the raw token value except the single startup login-URL
  line (localhost operator convenience); never log QR payloads.
- Behavior of existing `/health`, `/health/ready`, `/metrics` (other than the new token
  gate on `/metrics`) is unchanged.

## Interfaces (agreed shapes across tasks)

```ts
// src/platforms/whatsapp/login-store.ts
export type LoginMode = 'web' | 'terminal' | 'both';
export type LoginLinkState = 'pending' | 'linked';
export interface LoginSnapshot { state: LoginLinkState; qr: string | null; }

export function routeLoginQr(qr: string, mode: LoginMode): void; // terminal and/or publishQr per mode
export function publishQr(qr: string): void;      // sets qr, state='pending', notifies
export function markLinked(): void;               // qr=null, state='linked', notifies
export function markUnlinked(): void;             // state='pending', notifies (keeps last qr null)
export function getSnapshot(): LoginSnapshot;
export function subscribe(fn: (s: LoginSnapshot) => void): () => void; // returns unsubscribe
export function setActiveSocket(sock: WASocket | null): void;
export function getActiveSocket(): WASocket | null;
export function __resetLoginStore(): void;         // test-only reset

// src/platforms/whatsapp/login-server.ts
export function createLoginRequestHandler(opts: { token: string }):
  (req: IncomingMessage, res: ServerResponse) => boolean; // true iff it owned the request

// src/middleware/health.ts — startHealthServer options extended
options?: { metricsEnabled?: boolean; authToken?: string;
            extraHandler?: (req: IncomingMessage, res: ServerResponse) => boolean };
```

Route contract (all on the health server, host = HEALTH_BIND_HOST):
- `GET /whatsapp/login?token=T` → 200 text/html (two-tab page) | 401
- `GET /whatsapp/login/stream?token=T` → 200 text/event-stream; sends initial snapshot
  immediately, then one `data: <json>\n\n` per store update; unsubscribes on client close | 401
- `POST /whatsapp/login/pair?token=T` body `{"phoneNumber":"..."}` → 200 `{"code":"XXXXXXXX"}`
  | 400 invalid phone | 401 | 503 `{"error":"not_ready"}` when no active socket
- SSE JSON payload: `{ state: 'pending'|'linked', qrDataUrl: string|null }` where qrDataUrl is
  a PNG data URL from `qrcode.toDataURL(qr)` (null when no QR / linked).

---

## Task 1 — Config, dependency, and login store

**Files:** `src/utils/config.ts`, `package.json`, `src/platforms/whatsapp/login-store.ts`,
`tests/whatsapp-login-store.test.ts`, `tests/config-login-mode.test.ts`.

1. Add to the env schema (near the other `WHATSAPP_*` keys):
   - `WHATSAPP_LOGIN_MODE: z.enum(['web', 'terminal', 'both']).default('web'),`
   - `WHATSAPP_LOGIN_TOKEN: z.string().optional(),` (operator override; else generated at runtime)
2. `package.json`: add deps `qrcode` (^1.5.4) and devDep `@types/qrcode` (^1.5.5); run
   `npm install` so the lockfile updates. `qrcode` is pure-JS (no native build).
3. Create `login-store.ts` implementing the interface above.
   - `routeLoginQr(qr, mode)`: if mode is `terminal` or `both`, call the existing
     `qrcode-terminal` generate (`qrcode.generate(qr, { small: true })`); if `web` or `both`,
     call `publishQr(qr)`. Keep the `@ts-expect-error` import shim for qrcode-terminal.
   - `subscribe` returns an unsubscribe that deletes the listener; `notify` wraps each
     callback in try/catch so one throwing subscriber can't break others.
   - `__resetLoginStore()` clears qr→null, state→'pending', socket→null, subscribers.
**Tests (self-seed env):**
- config: `WHATSAPP_LOGIN_MODE` defaults to `'web'`; an invalid value is rejected; a valid
  explicit value (`'terminal'`) is honored.
- store: `publishQr` sets snapshot `{state:'pending', qr}` and notifies subscribers;
  `markLinked` → `{state:'linked', qr:null}`; unsubscribe stops further notifications;
  `routeLoginQr` in `web` mode publishes but does NOT call qrcode-terminal; in `terminal`
  mode calls qrcode-terminal but does NOT publish; in `both` does both (mock qrcode-terminal
  and spy on publishQr).

## Task 2 — connection.ts lifecycle integration

**Files:** `src/platforms/whatsapp/connection.ts` (only).

1. Import from `./login-store.js`: `routeLoginQr`, `markLinked`, `markUnlinked`,
   `setActiveSocket`. Import `config` for `WHATSAPP_LOGIN_MODE`.
2. Immediately after `onSocketCreated?.(protectedSock);` also call
   `setActiveSocket(protectedSock);` so the pair endpoint always targets the live socket.
3. In the `qr` branch, replace the direct `qrcode.generate(...)` call with
   `routeLoginQr(qr, config.WHATSAPP_LOGIN_MODE);` (remove the now-unused direct
   qrcode-terminal import from this file — it moved to login-store).
4. On `connection === 'open'`: call `markLinked();` (alongside existing markConnected).
5. On `connection === 'close'`: call `markUnlinked();` (alongside existing markDisconnected).
   Do NOT null the active socket here — the next generation's `setActiveSocket` replaces it,
   preserving the Phase-1 single-socket retirement flow unchanged.
**Tests:** this is lifecycle glue around a live Baileys socket; the routing logic itself is
unit-tested via `routeLoginQr` in Task 1. No new heavy socket test. State in the report that
the mode/publish/mark logic lives in login-store and is covered there; connection.ts only
wires call sites. (Reviewer: integration glue, not a testability gap.)

## Task 3 — Login web server (routes, page, QR render, pairing)

**Files:** `src/platforms/whatsapp/login-server.ts`, `src/platforms/whatsapp/login-page.ts`
(exported HTML string), `tests/whatsapp-login-server.test.ts`.

1. `createLoginRequestHandler({ token })` returns `(req, res) => boolean`. Return `false`
   immediately (unhandled) unless the path starts with `/whatsapp/login`.
2. Token check helper: constant-time compare of the `token` query param against `token`;
   on failure write 401 JSON `{"error":"unauthorized"}` and return `true` (owned+rejected).
3. `GET /whatsapp/login`: 200 `text/html`, body from `login-page.ts`. The page has two tabs
   (Scan QR / Pair with code); its embedded JS reads `token` from `location.search`, opens
   `EventSource('/whatsapp/login/stream?token='+token)`, renders `qrDataUrl` into an `<img>`,
   shows "Linked ✓" when `state==='linked'`, and the Pair tab POSTs `{phoneNumber}` to
   `/whatsapp/login/pair?token='+token` and displays the returned code.
4. `GET /whatsapp/login/stream`: SSE. Set headers `content-type: text/event-stream`,
   `cache-control: no-cache`, `connection: keep-alive`; call `res.flushHeaders?.()`. Send the
   current snapshot immediately (render QR to data URL when present), then `subscribe(...)`
   and push on each update. On `req.on('close')` unsubscribe and `res.end()`. Rendering:
   `await qrcode.toDataURL(qr)` (PNG). Guard against post-close writes.
5. `POST /whatsapp/login/pair`: read+size-limit the body (reject >4 KB → 413), JSON-parse,
   extract `phoneNumber`. Normalize by stripping everything except digits; validate 8–15
   digits else 400 `{"error":"invalid_phone"}`. `getActiveSocket()`; if null → 503
   `{"error":"not_ready"}`. Else `const code = await sock.requestPairingCode(digits);` → 200
   `{"code"}`. Wrap the Baileys call in try/catch → 500 `{"error":"pairing_failed"}`.
**Tests (self-seed env; use node `http` mocks or a real ephemeral server on 127.0.0.1:0):**
- 401 when token missing/wrong on GET page, GET stream, POST pair.
- GET page with good token → 200 and body contains both tab labels.
- SSE with good token → emits an initial event; after `publishQr('x')`, emits an event whose
  JSON has `state:'pending'` and a non-null `qrDataUrl`; after `markLinked()`, `state:'linked'`.
- POST pair: bad phone → 400; no active socket → 503; with a stubbed socket whose
  `requestPairingCode` resolves `'ABCD1234'` → 200 `{code:'ABCD1234'}` and the socket was
  called with the normalized digits.

## Task 4 — Wire into health server + startup token

**Files:** `src/middleware/health.ts`, `src/index.ts`, `tests/health-login-wiring.test.ts`.

1. `health.ts` `startHealthServer(port, host, options?)`: accept `authToken?` and
   `extraHandler?`. In the request handler, FIRST call `extraHandler?.(req, res)`; if it
   returns `true`, stop (it owned the request). Otherwise run the existing health/metrics
   logic. For `/metrics`: when `authToken` is set, require `?token===authToken` (constant-time)
   else 401 — placed after `metricsEnabled` gate, before rendering. `/health` and
   `/health/ready` are unchanged and un-gated.
2. `index.ts`: generate `const loginToken = config.WHATSAPP_LOGIN_TOKEN ?? randomBytes(24).toString('hex');`
   (import `randomBytes` from `crypto`). Build `const loginHandler = createLoginRequestHandler({ token: loginToken });`
   Pass `{ metricsEnabled: config.METRICS_ENABLED, authToken: loginToken, extraHandler: loginHandler }`
   to `startHealthServer`. When `WHATSAPP_LOGIN_MODE` is `web` or `both` and not healthOnly,
   log one info line: the login URL
   `http://${config.HEALTH_BIND_HOST}:${config.HEALTH_PORT}/whatsapp/login?token=${loginToken}`
   with a note to open it if WhatsApp needs linking.
**Tests (self-seed env; ephemeral server on 127.0.0.1:0):**
- `/metrics` with `authToken` set: 401 without token, 200 with correct token (metricsEnabled true).
- `extraHandler` returning true short-circuits: a request to `/whatsapp/login/...` reaches the
  handler and the health branch does not run (assert via a spy handler).
- `/health` still 200 and un-gated with `authToken` set.

## Task 5 — Final whole-branch review (Phase 2)

Broad review of all Phase-2 commits (base e3a4c4b..HEAD) on the most capable model. Verify
global constraints, token gate correctness (constant-time, 401 paths), SSE cleanup on client
close, no port/host regressions, ESM `.js`, test self-seeding. Fix Critical/Important in one
wave, re-review, then update the ledger and stop for the user (do not merge; user pushes).

## Done criteria (whole phase)
- `WHATSAPP_LOGIN_MODE=web` (default): terminal prints no QR; browser page links via QR + pair.
- Token required on all login routes and `/metrics`; 401 otherwise.
- All named test files pass with NO env prefix; `npm run typecheck` + `lint` clean;
  `npm run audit:deps` still exit 0.
- Single-socket invariant and Phase-1 reconnect behavior unchanged.
