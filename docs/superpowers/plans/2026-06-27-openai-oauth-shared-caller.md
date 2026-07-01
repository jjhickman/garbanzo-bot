# Plan 3 — OpenAI OAuth + Shared Cloud-Provider Caller (Phase 3)

Design: docs/superpowers/specs/2026-06-27-whatsapp-login-openai-oauth-hardening-design.md (§4 Phase 3)
Branch: codex/plan-garbanzobot-hardening → PR #164
Base before Task 1: 773d707

Split into 3a (shared caller refactor, behavior-preserving) then 3b (OpenAI OAuth, flag-gated
experimental). 3a de-risks 3b by giving OpenAI a single call path to add an auth variant to.

## Spike outcome (recorded)

The "Sign in with ChatGPT" runtime path is confirmed **feasible but unofficial/ToS-grey** and
was **not validated against a live token**. It impersonates the Codex client against OpenAI's
private ChatGPT backend:
- OAuth: client_id `app_EMoamEEZ73f0CkXaXp7hrann`, `https://auth.openai.com/oauth/authorize` +
  `/oauth/token`, PKCE S256, redirect `http://localhost:1455/auth/callback`, scope
  `openid profile email offline_access`, authorize params `id_token_add_organizations=true` +
  `codex_cli_simplified_flow=true` + `originator=…`. Token response: `access_token`,
  `refresh_token`, `id_token` (JWT carries the account id), expiry (ms). Refresh ~5 min before
  expiry / reactively on 401.
- Runtime: Responses API at `https://chatgpt.com/backend-api/wham` with `Authorization: Bearer`
  + `ChatGPT-Account-Id`; quirks: `input_text` content type, `store:false`, `instructions`
  (system) required, full history each call.
Per the design's spike gate, the runtime path ships **flag-gated and documented experimental**,
with bulletproof fallback to the next provider on any 4xx/5xx. Login + token storage/refresh are
fully unit-tested with mocked HTTP; the `/wham` call shape is best-effort from community reports.

## Global Constraints (binding — reviewers copy verbatim)

- **ESM `.js`** on every relative import.
- **Test env** self-seed at top of every new/changed test file (OWNER_JID / OPENROUTER_API_KEY /
  AI_PROVIDER_ORDER), before any app import; named files pass with NO env prefix.
- **Behavior-preserving (3a):** the shared caller must preserve the existing circuit-breaker
  semantics EXACTLY — threshold 3 consecutive failures, 60s cooldown, per-provider isolation,
  reset on success, open→throw before calling. No change to request/response shapes or parsers.
- **OAuth is never a hard dependency (3b):** any OAuth failure (missing/expired token, refresh
  failure, 4xx/5xx from `/wham`) must degrade to the next provider in `AI_PROVIDER_ORDER`, never
  crash routing. `OPENAI_AUTH_MODE=apikey` (default) leaves all current behavior byte-for-byte.
- **Secrets:** the OAuth token file is `data/openai-oauth.json`, gitignored, written mode `0600`;
  never log tokens.
- **No network in tests:** all HTTP (login exchange, refresh, `/wham`) is mocked.

## Interfaces (agreed shapes)

```ts
// src/ai/cloud-call.ts  (new — the shared caller)
export interface CloudCallOptions {
  provider: CloudProvider;              // breaker key + response.provider
  model: string;
  timeoutMs?: number;                   // default config.CLOUD_REQUEST_TIMEOUT_MS
  perform: (signal: AbortSignal) => Promise<string>;  // returns raw text; throws on transport/HTTP error
}
export async function callCloudProvider(opts: CloudCallOptions): Promise<CloudResponse>;
export function __resetCloudBreakers(): void;          // test-only

// src/ai/cloud-providers.ts  (add a shared HTTP transport helper)
export async function performHttpRequest(req: ProviderRequest, signal: AbortSignal): Promise<string>;
```

Breaker state lives in a module-level `Map<CloudProvider, {failures:number; openUntil:number}>` in
cloud-call.ts. `callCloudProvider`: if open → throw `"<provider> circuit breaker open (Ns remaining)"`;
else AbortController+timeout, `text = (await perform(signal)).trim()`, empty→throw
`"<provider> returned empty response"`; success resets breaker + returns `{text, provider, model}`;
error increments failures, opens at threshold, rethrows; `finally` clears timeout.

---

## Plan 3a — Shared cloud-provider caller (behavior-preserving)

### Task 3a.1 — cloud-call.ts + performHttpRequest, with tests
- Create `src/ai/cloud-call.ts` per interface. Extract the breaker/timeout logic verbatim in
  semantics from chatgpt/claude/bedrock (threshold 3, cooldown 60_000). Add `performHttpRequest`
  to cloud-providers.ts (the fetch + `!res.ok`→`"${provider} API error ${status}: ${body}"` +
  `parser(json)` path used by openrouter/anthropic/openai/gemini).
- Tests `tests/cloud-call.test.ts`: success resets; N failures below threshold rethrow without
  opening; 3rd consecutive failure opens the breaker (next call throws "circuit breaker open");
  breakers are per-provider isolated; empty text throws; timeout aborts (fake timers or an
  injected perform that observes the signal). `__resetCloudBreakers()` in beforeEach.

### Task 3a.2 — Migrate chatgpt / claude / gemini to the shared caller
- Rewrite `callChatGPT`, `callClaude`, `callGemini` as thin wrappers: build the request
  (`buildProviderRequest`), null→throw the existing "not configured" error, then
  `return callCloudProvider({ provider, model: req.model, perform: (s) => performHttpRequest(req, s) })`.
  Gemini KEEPS its non-JSON-guard behavior (fold into performHttpRequest OR a gemini-local perform
  that preserves the "gemini returned non-JSON response" error). Gemini now GAINS the breaker.
- Remove the now-dead per-file breaker/timeout state. Preserve exported signatures exactly.
- Tests: `tests/gemini.test.ts` must still pass; add a focused test that gemini now opens a
  breaker after 3 failures (proves the gain). claude/chatgpt covered via cloud-call.test + a
  light wrapper test if not already covered.

### Task 3a.3 — Migrate bedrock + router aiResult type-safety
- Rewrite `callBedrock` to use `callCloudProvider({ provider:'bedrock', model, perform })` where
  `perform(signal)` runs the `ConverseCommand` with `abortSignal: signal` and extracts text.
  `tests/bedrock.test.ts` must still pass.
- `router.ts`: replace the `aiResult = { text:'', provider:'openai', model:'' }` placeholder +
  `resolved` boolean with a type-safe accumulator (e.g. `let aiResult: CloudResponse | null = null;`
  assigned in the loop; after the loop, `if (!aiResult) throw …`). Behavior identical; no
  placeholder object. Existing router behavior covered by the suite.

## Plan 3b — OpenAI OAuth (flag-gated, experimental)

### Task 3b.1 — Config + token store/refresh module
- Config: `OPENAI_AUTH_MODE: z.enum(['apikey','oauth']).default('apikey')`. When `oauth`, OpenAI is
  "configured" via the token file rather than `OPENAI_API_KEY` — update the three gates
  (config.ts `configuredProviders`, router `isProviderConfigured`, and buildProviderRequest's
  openai branch) to treat oauth mode as configured when a token file exists.
- `src/ai/openai-oauth.ts`: token file read/write (`data/openai-oauth.json`, mode 0600), schema
  `{access_token, refresh_token, id_token, account_id, expires_at}`; `getOpenAIAccessToken()`
  returns a valid token, refreshing via refresh_token when within a 5-min skew of expiry; parse
  `account_id` from the id_token JWT (base64url payload) if not stored. All HTTP mocked in tests.
- Tests `tests/openai-oauth.test.ts`: read/write round-trip; expiry-skew triggers refresh; refresh
  updates the stored token; refresh failure surfaces an error (caller will fall back). File mode
  0600 asserted where the platform supports it.

### Task 3b.2 — Responses-API request variant + wiring, fallback
- `buildProviderRequest('openai', …)` in oauth mode returns a ProviderRequest targeting
  `https://chatgpt.com/backend-api/wham` with the Responses body (`instructions` = systemPrompt,
  `input` items with `input_text` content, `store:false`) + a Responses parser; headers filled at
  call time with the fresh bearer + `ChatGPT-Account-Id`. Because headers need an async token, the
  openai perform in oauth mode calls `getOpenAIAccessToken()` then `performHttpRequest`.
- `callChatGPT` branches on `OPENAI_AUTH_MODE`: apikey → today's path; oauth → oauth perform.
  Any 4xx/5xx or token error throws so the router falls to the next provider (verified by test).
- Module header documents the ToS/experimental status and the unverified `/wham` shape.
- Tests `tests/openai-oauth-runtime.test.ts`: oauth-mode success parses a Responses payload;
  401 → throws (router fallback); apikey mode unchanged (still hits chat/completions).

### Task 3b.3 — Login command
- `scripts/openai-login.mjs` + `package.json` `"openai:login"`: PKCE flow, open browser to the
  authorize URL, localhost:1455 callback captures the code, exchange at `/oauth/token`, write the
  token file (0600). Actionable errors (browser-open failure → print URL; callback timeout → retry
  hint). Not unit-tested (interactive), but the token-exchange helper it shares with
  openai-oauth.ts IS tested.

### Task 3b.4 — Docs
- README + a short note: `OPENAI_AUTH_MODE`, `npm run openai:login`, the ToS/experimental caveat,
  and that apikey remains the default. Add `data/openai-oauth.json` to `.gitignore` if not covered.

## Wizard integration (Phase 5, not here)
Setup-wizard prompts for OPENAI_AUTH_MODE + offering to run the login are deferred to Phase 5.

## Done criteria
- 3a: full suite green with identical provider behavior; gemini gains a breaker; no placeholder
  aiResult; no dead breaker state.
- 3b: `OPENAI_AUTH_MODE=apikey` byte-for-byte unchanged; oauth path flag-gated, fully fallback-
  protected, documented experimental; token store/refresh unit-tested with mocked HTTP.
- typecheck + lint clean; audit:deps exit 0.
