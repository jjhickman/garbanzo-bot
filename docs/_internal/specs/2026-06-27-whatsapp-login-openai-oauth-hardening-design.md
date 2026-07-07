# Design: WhatsApp Browser Login, OpenAI OAuth, and Hardening (PR #164 follow-on)

- Status: Proposed
- Date: 2026-06-27
- Branch: `codex/plan-garbanzobot-hardening` → PR #164 ("WhatsApp Bot Detection Hardening")
- Base: `main`

## 1. Goals

Three user-requested outcomes, plus folded-in improvements surfaced by a reliability/security/DX audit:

1. **OpenAI OAuth** — let Garbanzo use a ChatGPT subscription via a "Sign in with ChatGPT"
   OAuth flow, added to the setup wizard, **with API-key/other-provider fallback**.
2. **WhatsApp browser login** — replace terminal QR with a browser login page (QR + pairing
   code) and stop the frequent reconnects that previously got the account bot-flagged.
3. **Other improvements** — implement an audited set of reliability, security, and code-quality
   fixes; document the rest.

## 2. Context and constraints

- The bot uses Baileys for a personal WhatsApp account (see `ADR-0001`). Account-risk is
  accepted but must be minimized; the reconnect path is the highest-risk surface.
- PR #164 already added an outbound safety layer (`baileys-antiban`), removed the aggressive
  "force-reconnect when a group is quiet" loop, and added classified reconnect backoff. This
  design **builds on** that work; it does not revisit the outbound dispatcher.
- The ChatGPT-subscription-via-OAuth path is **unofficial and against OpenAI ToS**. It works
  today (community tools reuse the Codex PKCE flow) but may be shut down at any time, as
  Anthropic and Google did for their CLIs in April 2026. The design therefore isolates it and
  always preserves a working fallback.

### Root-cause correction (anti-ban)

The user attributed the prior bot-flag to "frequent QR refresh." The audit indicates the real
drivers are reconnect-lifecycle bugs:

- **Zombie sockets** — `connection.ts` never closes the old socket before
  `setTimeout(() => startConnection(...))`, so reconnects can stack **simultaneous WebSocket
  connections from one account**.
- **Stacking timers/listeners** — each reconnect calls `scheduleDigest()` and
  `registerIntroCatchUp()` again without clearing the previous timer/listeners, producing
  **duplicate automated sends** that compound across reconnects.

QR rotation within a single connection attempt (~every 20s) is **not** a reconnect and is not a
flag driver, so the browser page can refresh the QR freely.

## 3. Scope (approved)

In this PR: all three goals plus the full improvement set, including the larger refactors
(shared cloud-provider caller, SQLite/Postgres dedup, splitting the Slack demo server,
sanitization tests). Login default = **browser**, terminal QR opt-in via env.

## 4. Architecture by phase

Phases are ordered so each is independently reviewable and the PR could be split on a phase
boundary if desired.

### Phase 0 — Unblock CI
- Resolve the `npm audit` failure: **js-yaml** advisory GHSA-h67p-54hq-rp68 (transitive). Pin/
  override to a patched version (npm `overrides`) so the Quality Gate passes. No app code change.
- **Done when:** `npm run audit:deps` and the CI Quality Gate are green.

### Phase 1 — Reconnect lifecycle + graceful shutdown (anti-ban core)
- **`PlatformRuntime.stop()`** — add optional `stop(): Promise<void>` to `src/platforms/types.ts`;
  implement for WhatsApp (close socket, clear timers/listeners), Discord, Slack.
- **Socket teardown on reconnect** — in `connection.ts`, before scheduling a reconnect:
  remove listeners and end the previous socket so only one connection exists at a time. The
  `outbound-safety` instance is already destroyed on close; ensure ordering is correct.
- **Timer/listener cleanup** — `scheduleDigest()` and `registerIntroCatchUp()` return disposers;
  `startConnection`'s ready path disposes any previous registration before re-registering. Track
  the current registration generation so callbacks from a stale socket no-op.
- **Shutdown wiring** — `src/index.ts` awaits `runtime.stop()` inside a bounded
  `Promise.race([..., timeout])` so a hung `closeDb()` cannot block exit; `.unref()` the memory
  watchdog and any keep-alive intervals.
- **Tests:** simulate N reconnects; assert exactly one active socket, one digest timer, one intro
  listener; assert shutdown completes within the timeout.

### Phase 2 — WhatsApp browser login
- **QR provider** — `connection.ts` publishes the latest QR string and link-state to a small
  in-memory `whatsapp-login` store instead of (by default) printing to the terminal.
- **Login web UI** — `GET /whatsapp/login` on the existing health server, served from a static
  template. Two tabs:
  - **Scan QR:** renders the current QR as an `<img>` (PNG/SVG via the `qrcode` lib), live-updated
    via **SSE** (`GET /whatsapp/login/stream`) as Baileys rotates it; shows "Linked ✓" on success.
  - **Pair with code:** input for the bot phone number → `POST /whatsapp/login/pair` calls
    `sock.requestPairingCode(number)` → returns the 8-char code to type into WhatsApp ›
    Linked Devices › Link with phone number.
- **Auth gate (folds Sec-4)** — a one-time **login token** is generated at startup, printed to the
  logs/console, and required as `?token=…` on all `/whatsapp/login*` routes. The same token guards
  `/metrics`. Routes bound to `127.0.0.1` by default (unchanged).
- **Config** — `WHATSAPP_LOGIN_MODE=web|terminal|both` (default `web`). On startup when linking is
  needed, print the login URL. `qrcode-terminal` retained for `terminal`/`both`.
- **Tests:** token required (401 without/with wrong token); SSE emits on QR update; pair endpoint
  validates phone number; mode switch honored.

### Phase 3 — OpenAI OAuth provider + shared cloud-provider caller
- **Shared caller (folds DX-7, DX-12)** — extract the timeout + circuit-breaker + error-classify
  logic duplicated across `chatgpt.ts`, `claude.ts`, `bedrock.ts` into a single
  `callCloudProvider(req)` in `src/ai/cloud-providers.ts` (or a new `cloud-call.ts`). Migrate all
  providers, including adding the missing breaker to `gemini.ts`. Per-provider files shrink to a
  `buildProviderRequest` + thin wrapper.
- **OpenAI auth modes** — `OPENAI_AUTH_MODE=apikey|oauth` (default `apikey`).
  - **apikey:** unchanged — `api.openai.com/v1/chat/completions`, Bearer key.
  - **oauth:** a new `src/ai/openai-oauth.ts` module owns the token lifecycle:
    - **Login command** `npm run openai:login` (script `scripts/openai-login.mjs`): PKCE OAuth
      against `auth.openai.com` using the public Codex client id; opens the browser; a localhost
      callback captures the code; exchanges for `{access_token, refresh_token, id_token,
      account_id, expires_at}`; writes to `data/openai-oauth.json` (gitignored, mode `0600`).
    - **Runtime:** `getOpenAIAccessToken()` returns a valid token, refreshing via refresh-token
      when within a skew of expiry. `buildProviderRequest('openai', …)` in oauth mode targets the
      **ChatGPT/Codex Responses backend** with the account header and a Responses-API request
      body + parser (distinct from chat/completions).
  - **Fallback:** on `401/403` (expired or ToS-revoked) the breaker trips and `router.ts` falls
    through to the next provider in `AI_PROVIDER_ORDER`. OAuth is never a hard dependency.
- **Implementation spike (called out, not hand-waved):** before coding the runtime call, verify
  current Codex OAuth endpoints, client id, the Responses backend URL/headers, and response shape
  against a live token; record findings in the module header. If the call shape can't be confirmed,
  ship login + token storage and keep the runtime path behind the flag (documented as experimental).
- **Wizard integration:** see Phase 5.
- **Tests:** token store read/write/refresh (mocked HTTP); expiry-skew refresh; 401 → fallback;
  apikey mode unchanged.

### Phase 4 — Security quick wins
- **Sec-1/Sec-2** — move the **Gemini** key (`cloud-providers.ts`) and **Google** key
  (`weather.ts`) out of the URL query string into request headers (`x-goog-api-key`), so keys stop
  leaking into logs/proxies.
- **Sec-5 (low)** — normalize IPv6-mapped IPv4 (`::ffff:…`) in the health rate-limiter key.
- **Health-5 / Health-7** — evict stale `healthRateWindow` entries; `.unref()` watchdog (overlaps
  Phase 1).
- **Tests:** request builders send keys in headers, not URLs.

### Phase 5 — Wizard field-table refactor (folds DX-6, Sec-3)
- Replace the ~500 lines of `nonInteractive ? cli : prompt` ternaries in `scripts/setup.mjs` with a
  **declarative field table** (`{ key, env, prompt, default, cliFlag, secret?, when? }`) driven by a
  single resolver. Target ~150 lines for the field section.
- **Mask secrets (Sec-3):** `secret` fields show `[set]/[empty]`, never the raw value, in prompts
  and dry-run previews.
- **New wizard steps:**
  - OpenAI: when OpenAI selected, ask auth mode (API key vs "Sign in with ChatGPT"); for OAuth,
    offer to run `npm run openai:login` now; write `OPENAI_AUTH_MODE`.
  - WhatsApp: ask `WHATSAPP_LOGIN_MODE` (default web) and print the login URL in the summary.
- **Tests:** non-interactive parity for new fields; secret masking in dry-run output; resolver unit
  tests.

### Phase 6 — Larger refactors (approved)
- **DX-9** — split `src/platforms/slack/demo-server.ts` (1310 lines) into focused modules: HTTP
  server, demo handlers (Slack/Discord), Turnstile/abuse protection. Behavior-preserving.
- **DX-10** — reduce SQLite/Postgres duplication: extract shared SQL/query-shaping into a common
  layer behind the existing backend interface; keep dialect-specific bits isolated. Behavior- and
  schema-preserving; covered by existing `postgres-backend` tests + new shared-layer tests.
- **DX-8** — add `tests/sanitize.test.ts` for `src/middleware/sanitize.ts` (injection detection,
  control-char stripping, JID validation).
- **DX-11** — `router.ts` `aiResult` init: use a type-safe pattern instead of the placeholder
  object.

### Phase 7 — Docs
- `docs/IMPROVEMENTS.md` — full audit findings with status (done/deferred), so nothing is lost,
  including deferred low-priority items (router module-state races #7, retry handler timeout #9,
  Slack token-manager concurrency note #10, config pre-logger logging #11).
- Update `ADR-0001` consequences and add a short ADR or section for OpenAI OAuth (unofficial,
  fallback-protected) and the WhatsApp login surface.
- README/SETUP_EXAMPLES: browser login walkthrough and OpenAI OAuth instructions with the ToS
  caveat.

## 5. Data flow summaries

- **WhatsApp link:** Baileys QR/pair-state → in-memory login store → `/whatsapp/login` (token-gated)
  → operator scans/pairs in browser → `connection 'open'` → store marks linked → page shows ✓.
- **OpenAI request (oauth):** `router.ts` → `buildProviderRequest('openai')` → `openai-oauth`
  ensures fresh token → Responses backend → parse → `CloudResponse`. On 401/403 → breaker → next
  provider.

## 6. Error handling

- OAuth: network/refresh failures and 401/403 never crash routing; they degrade to fallback. Login
  command surfaces actionable errors (browser open failure → print URL; callback timeout → retry).
- Login web: token mismatch → 401; pair errors → JSON error to UI; SSE disconnects auto-reconnect.
- Reconnect: bounded backoff (existing `classifyDisconnect`); single-socket invariant enforced.

## 7. Testing strategy

Per-phase unit/integration tests above, plus: full `npm run check` (audit:secrets, audit:deps,
typecheck, lint, test) green, and the CI Quality Gate green. New behavior covered before merge.

## 8. Risks and mitigations

- **OpenAI OAuth fragility / ToS** — isolated module, flag-gated, always-fallback; documented as
  experimental; spike validates feasibility before wiring the runtime call.
- **Large PR** — phased and independently reviewable; can split at a phase boundary if review load
  is high.
- **Refactor regressions (Phase 6)** — behavior-preserving, guarded by existing + new tests; done
  last so feature work isn't blocked.
- **Login endpoint exposure** — token-gated + localhost-bound; never enabled on `0.0.0.0` without
  the token.

## 9. Out of scope

Outbound dispatcher internals (already shipped in #164), new messaging platforms, content
mutation/stealth features explicitly excluded by ADR-0001.
