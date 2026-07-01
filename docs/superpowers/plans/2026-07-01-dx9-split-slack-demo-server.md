# Plan — DX-9: Split `slack/demo-server.ts` (Phase 6)

Spec: `docs/superpowers/specs/2026-06-27-whatsapp-login-openai-oauth-hardening-design.md` §Phase 6.
Branch: `codex/plan-garbanzobot-hardening`. Base: `a227192`.

## Goal

Split the 1310-line `src/platforms/slack/demo-server.ts` into focused modules. **Strictly
behavior-preserving** — no functional change, no route change, no HTML change. Public exports
`createSlackDemoServer` and `renderDemoPageHtml` keep their current signatures and import path so no
call site changes.

## Guardrails (must stay green the entire time)

- `tests/slack-demo.test.ts`, `tests/discord-demo.test.ts`, `tests/multi-platform-demo-server.test.ts`
- `npm run typecheck`, `npm run lint`, full `npm test`
- Verify env prefix for local runs:
  `OWNER_JID='test_owner@s.whatsapp.net' OPENROUTER_API_KEY='test_key_ci' AI_PROVIDER_ORDER='openrouter'`

## Target module layout (all under `src/platforms/slack/`)

Current symbols (line refs in the pre-split file) grouped by responsibility:

1. **`demo-page.ts`** — presentation. `renderDemoPageHtml` (re-exported from `demo-server.ts` to
   preserve the public path) + `escapeHtml`. The ~800-line HTML template.
2. **`demo-protection.ts`** — abuse/rate protection. `verifyTurnstileToken`, `readTurnstileToken`,
   `allowRequest`, the `RateLimitEntry` type + rate-limit map handling, `getClientIp`,
   `buildDemoSenderId`.
3. **`demo-handlers.ts`** — request→response demo logic. `processDemoMessage`, `resolveDemoPlatform`,
   `parseBodyPlatform`, `normalizeDemoText`, `healthPayload`, and the model-config helpers
   `buildDemoModelConfig` / `modelForProvider` / `describeCostProfile` / `parseProviderOrder`.
4. **`demo-server.ts`** (thin) — HTTP wiring only. `createSlackDemoServer` (routing loop,
   `isSupportedPath`, `isSupportedPostPath`, `readJsonBody`, `writeCorsHeaders`, `writeJson`,
   `writeHtml`), re-exporting `renderDemoPageHtml`.

Exact boundaries are the implementer's call **as long as**: (a) the two public exports stay in place
via `demo-server.ts`, (b) no symbol changes behavior, (c) shared types move to a small
`demo-types.ts` if needed to avoid cycles.

## Tasks

- **T1** — Extract `demo-page.ts` (HTML + escapeHtml); re-export `renderDemoPageHtml` from
  `demo-server.ts`. Run guard tests.
- **T2** — Extract `demo-protection.ts` (turnstile + rate limit + client-ip/sender helpers). Run guards.
- **T3** — Extract `demo-handlers.ts` (message processing + platform resolution + model config). Run guards.
- **T4** — Leave `demo-server.ts` as the thin HTTP/routing shell; confirm it only wires the above.
  Full `npm run check`.

Each task: behavior-preserving move + fix imports only. No logic edits. If a move needs a logic
tweak to compile, stop and flag it — that signals a hidden coupling to document, not silently change.

## Definition of done

- All four modules created; `demo-server.ts` is the thin shell.
- Public import path `src/platforms/slack/demo-server.ts` still exports `createSlackDemoServer` and
  `renderDemoPageHtml`.
- Full suite green (same pass count as pre-split, +any new module-boundary tests), typecheck + lint
  clean, `audit:deps` exit 0.
- Independent Codex review confirms no behavior change.
