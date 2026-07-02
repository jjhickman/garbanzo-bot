# Hardening & Improvements — status

Tracks the reliability / security / DX audit that drove the PR #164 follow-on work
(design: `docs/superpowers/specs/2026-06-27-whatsapp-login-openai-oauth-hardening-design.md`).
Each item is marked **Done** (with the phase/commit area), **Deferred**, or **N/A**.

## Reliability / anti-ban

| # | Item | Status |
|---|------|--------|
| R1 | **Zombie sockets** — old Baileys socket not ended before scheduling a reconnect, stacking simultaneous connections from one account | ✅ Done — Phase 1 (single-socket retirement in `connection.ts`, preserves `creds.update`) |
| R2 | **Stacking timers/listeners** — each reconnect re-armed digest + intro catch-up without clearing the previous, producing duplicate automated sends | ✅ Done — Phase 1 (`scheduleDigest`/`registerIntroCatchUp` return disposers; each generation disposes the previous) |
| R3 | **In-flight intro catch-up** kept sending from a retired generation | ✅ Done — Phase 1 (cancellation predicate; mark-and-send kept atomic) |
| R4 | **Graceful shutdown** could hang on a stuck `closeDb()` | ✅ Done — Phase 1 (`runtime.stop()` + bounded `Promise.race`; watchdog `unref`'d) |
| R5 | Reconnect had no bounded backoff / classification | ✅ Done (baseline PR #164 `classifyDisconnect`; retained) |

## Security

| # | Item | Status |
|---|------|--------|
| Sec-1 | **Gemini API key in URL query** (leaks to logs/proxies) | ✅ Done — Phase 4 (`x-goog-api-key` header) |
| Sec-2 | **Google API key in URL query** (weather + venues) | ✅ Done — Phase 4 (`X-Goog-Api-Key` header) |
| Sec-3 | **Wizard printed raw secret values** in prompts | ✅ Done — Phase 5 (`[set]`/`[empty]` masking; dry-run already `[REDACTED]`) |
| Sec-4 | **Login/metrics endpoints unauthenticated** | ✅ Done — Phase 2 (one-time login token, constant-time compare, gates `/whatsapp/login*` + `/metrics`) |
| Sec-5 | IPv6-mapped IPv4 not normalized in the health rate-limiter | ✅ Done — Phase 1 (`normalizeIp`) |
| Sec-6 | OpenAI OAuth token file must be protected | ✅ Done — Phase 3 (`data/openai-oauth.json`, gitignored, mode `0600`, never logged) |

## Health server

| # | Item | Status |
|---|------|--------|
| Health-5 | `healthRateWindow` grew unbounded | ✅ Done — Phase 1 (opportunistic stale-bucket eviction) |
| Health-7 | Memory watchdog interval not `unref`'d (kept process alive) | ✅ Done — Phase 1 |

## Features

| Item | Status |
|------|--------|
| **WhatsApp browser login** (QR via SSE + pairing code, token-gated, `WHATSAPP_LOGIN_MODE`) | ✅ Done — Phase 2 |
| Remote/headless linking over the network (`HEALTH_BIND_HOST=0.0.0.0` → LAN-IP login URLs + exposure warning; SSH-tunnel documented) | ✅ Done — Phase 2 follow-up |
| **OpenAI "Sign in with ChatGPT" OAuth** (`OPENAI_AUTH_MODE=oauth`, `npm run openai:login`) | ✅ Done — Phase 3 (**experimental, ToS-grey, fallback-protected**; runtime `/wham` shape unverified against a live token) |

## DX / code quality

| # | Item | Status |
|---|------|--------|
| DX-7 / DX-12 | Timeout + circuit-breaker + error-classify **duplicated** across `chatgpt`/`claude`/`bedrock`; Gemini missing a breaker | ✅ Done — Phase 3a (`callCloudProvider`; Gemini gains a breaker; per-provider isolation) |
| DX-8 | No tests for `middleware/sanitize.ts` | ✅ Done — Phase 6 (`tests/sanitize.test.ts`) |
| DX-11 | `router.ts` `aiResult` placeholder object | ✅ Done — Phase 3a (`CloudResponse | null` accumulator) |
| DX-6 | ~500 lines of `nonInteractive ? cli : prompt` ternaries in `setup.mjs` | ✅ Done — Phase 5 (declarative `FIELD_TABLE` + resolver) |
| DX-9 | `slack/demo-server.ts` is 1310 lines | ✅ Done — Phase 6 (split into `demo-page`/`demo-protection`/`demo-handlers`/`demo-types` + thin `demo-server`; public exports unchanged; independently reviewed) |
| DX-10 | SQLite/Postgres backend duplication | ✅ Done — Phase 6 (`db-mappers.ts` + `db-query-shape.ts` shared behind `DbBackend`; SQL/dialect bits isolated; −318 backend lines; independently reviewed) |

## Deferred low-priority items

- **#7** `router.ts` module-state races (cached Ollama availability, cost-alert flags) — ✅ Done (TTL + single-flight Ollama availability; date-keyed cost alerts).
- **#9** retry handler lacks a per-attempt timeout — ✅ Done (optional `RETRY_ATTEMPT_TIMEOUT_MS`; default remains unchanged).
- **#10** Slack token-manager refresh concurrency — ✅ Done (existing single-flight refresh verified with regression coverage).
- **#11** config validation logs before the logger is initialized — ✅ Done (structured pre-logger `console.error` output with `npm run setup` guidance).

## Notes

- **OpenAI OAuth** is isolated and always falls back to the next provider in `AI_PROVIDER_ORDER`; it has
  **not** been validated end-to-end against a live ChatGPT token and should not be a sole provider.
  A malformed HTTP-200 `/wham` payload (neither `output_text` nor `output`) now throws → fallback,
  rather than returning a fake reply.
- **`/metrics` token gate** (Sec-4) is a behavior change for existing scrapers: append `?token=<T>` or
  pin `WHATSAPP_LOGIN_TOKEN`.
- **DX-10 Postgres coverage:** `tests/postgres-backend.test.ts` requires a live `DATABASE_URL` and is
  skipped without one, so the Postgres backend is guarded here by typecheck + `db-shared-layer` unit
  tests + independent review. Run it against a real Postgres in CI to exercise the extracted mappers
  end-to-end.

## Post-release deploy fixes (v0.2.x — surfaced during a real Raspberry Pi deploy)

| Item | Status |
|------|--------|
| **WhatsApp `515` (restartRequired) treated as fatal** — `baileys-antiban`'s `classifyDisconnect(515)` returns `shouldReconnect:false`, so the first QR link never completed (phone hung on "Logging in…"). `515` is the normal post-pairing reconnect signal. | ✅ Fixed — v0.2.2 (`connection.ts` reconnects on `DisconnectReason.restartRequired`; 401/loggedOut still pauses) |
| **Docker image build broken** — Alpine `edge/community` `yt-dlp` no longer resolves against the `node:25-alpine` base. | ✅ Fixed — v0.2.1 (install `yt-dlp` via `pip --break-system-packages`) |
| **Wizard `config/groups.json` ignored in Docker** — config was baked into the image, so host edits didn't apply. | ✅ Fixed — host `config/groups.json` bind-mounted read-only (edit + restart, no rebuild) |
| **Operator PII committed** — real phone number + moderator names in `config/groups.json` and test fixtures (also in published images/history). | ✅ Redacted going forward (placeholders); still present in git history + pre-v0.2.x images (separate scrub) |
| **Release runs always red** — `aquasecurity/trivy-action` pinned to `@0.34.0` (tags are `v`-prefixed), so the scan job failed at setup. | ✅ Fixed — pinned `@v0.36.0`; releases go green |
| **Headless OpenAI OAuth** — `localhost:1455` redirect can't be reached on a remote host. | ✅ Added `--manual` paste-back to `openai-login.mjs` (no SSH tunnel needed); see README |
