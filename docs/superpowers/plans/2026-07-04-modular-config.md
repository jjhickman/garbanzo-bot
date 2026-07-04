# Modular Config & Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One profile-selected `docker-compose.yml` for any combination of WhatsApp Garbanzo / Discord Remy / monitoring; layered env files with a shared `.env`; `MONITORING_TOKEN` replacing the overloaded `WHATSAPP_LOGIN_TOKEN` for all ops auth; modular config schema with platform-conditional requirements and empty-string hardening; multi-instance dashboards; the tracked small fixes. Breaking release (target v2.0.0), clean-slate redeploy sanctioned.

**Architecture:** See spec `docs/superpowers/specs/2026-07-04-modular-config-design.md`. Semantics-first ordering: config-behavior changes land with tests before the mechanical schema split; app wiring before compose; compose before monitoring/docs.

**Tech Stack:** TypeScript (ESM), Node 20+, Zod, Vitest, Docker Compose (profiles + multi-`env_file`), Prometheus/Grafana provisioning.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-04-modular-config-design.md`. Every task serves it.
- **HARD CONSTRAINT — auth/data preservation:** every named volume keeps its exact current `name:` (`garbanzo-bot-auth`, `garbanzo-bot-data`, `garbanzo-bot-remy-data`, `garbanzo-bot-qdrant`, `garbanzo-bot-prometheus`, `garbanzo-bot-grafana`). The owner's linked WhatsApp session lives in `garbanzo-bot-auth` and MUST survive. Any task touching compose asserts this in tests.
- Breaking changes are sanctioned (no back-compat shims, no `WHATSAPP_LOGIN_TOKEN` fallback for ops auth), but **behavior not named in the spec must be preserved** — the full suite stays green throughout.
- TS strict, no `any`, ESM `.js` imports, Pino logger only, Zod for env. `kebab-case.ts`, ~300-line ceiling.
- **Verify env prefix** (note: after T1, `OWNER_JID` is only required for whatsapp): `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter`. ALWAYS set it or config validation fails tests spuriously.
- Commits `type(scope): desc`, GitHub noreply author; `npm run check` before each commit. Never merge — push, PR, owner merges. Release/tag is NOT cut by this plan (owner migrates first).
- Problems inventory (13 items) from the exploration is the ground truth for what each task fixes; the whole-branch review checks coverage against it.

## File Structure

**Create:** `src/utils/config/` (`shared.ts`, `core.ts`, `ai.ts`, `whatsapp.ts`, `discord.ts`, `band.ts`, `vector.ts`, `monitoring.ts`, `integrations.ts`, `index.ts`), `.env.whatsapp.example`, `docs/MIGRATION-2.0.md`. Tests: `tests/config-hardening.test.ts`, `tests/compose-profiles.test.ts` (replaces `tests/remy-compose.test.ts`), `tests/grafana-dashboard.test.ts`, `tests/persona-name.test.ts`.
**Modify:** `src/utils/config.ts` (becomes re-export shim), `src/index.ts`, `src/middleware/health.ts` docs-comment, `src/ai/persona.ts`, `docker-compose.yml`, `monitoring/prometheus.yml`, `monitoring/grafana/dashboards/garbanzo.json`, `.env.example`, `.env.remy.example`, `.gitignore`, `scripts/setup.mjs` + `scripts/setup-fields.mjs`, docs listed in the spec, `AGENTS.md`, `CHANGELOG.md`.
**Delete:** `docker-compose.remy.yml` (folded into base as the `remy` profile).

---

## Task 1: Config semantics — MONITORING_TOKEN, optionalString hardening, platform-conditional OWNER_JID

**Files:** Modify `src/utils/config.ts` (still flat in this task). Test: `tests/config-hardening.test.ts`.

**Interfaces:**
- Produces: `optionalString` helper (`z.preprocess`: `'' | whitespace → undefined`, else trimmed string) in config.ts, applied to every plain `z.string().optional()` key (the inventory list: `DISCORD_DIGEST_CHANNEL_ID`, `DISCORD_RECAP_CHANNEL_ID`, `DISCORD_PRACTICE_CHANNEL_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_OWNER_ID`, `BEDROCK_MODEL_ID`, `BOT_PHONE_NUMBER`, all integration API keys, `SUPPORT_MESSAGE`, `GITHUB_ISSUES_TOKEN`, `SLACK_*`, `DATABASE_URL`, `POSTGRES_*`). `QDRANT_API_KEY` → `optionalString` (fixes the shipped-empty crash). New key `MONITORING_TOKEN: optionalString`. `OWNER_JID` → `optionalString` + `superRefine`: required with a clear error iff `MESSAGING_PLATFORM === 'whatsapp'`.
- Consumers unchanged in this task (`config.MONITORING_TOKEN` exists but unwired).

- [ ] **Step 1: Write failing tests** — `VAR=''` behaves as unset for a representative set (digest/recap channel ids fall back via `??`; `QDRANT_API_KEY=''` parses clean); `MONITORING_TOKEN` parsed; `MESSAGING_PLATFORM=discord` + no `OWNER_JID` → config parses; `whatsapp` + no `OWNER_JID` → exits with the named error. (Config loads at import — use the existing pattern for config tests: fresh `vi.resetModules()` + env seeding.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Audit every `config.OWNER_JID` call site for the now-`string | undefined` type: WhatsApp paths may assert (platform-guarded), the Discord demo-server + interactions fallback use `config.OWNER_JID ?? getDiscordOwnerId() ?? ''` or equivalent explicit handling — no `!`.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(config)!: MONITORING_TOKEN, empty-string hardening, platform-conditional OWNER_JID`

---

## Task 2: Config schema split into modules (mechanical)

**Files:** Create `src/utils/config/*.ts` per the spec's module map; `src/utils/config.ts` becomes `export { config, ... } from './config/index.js'` so all call sites stay untouched. Test: existing suite is the gate.

**Interfaces:**
- Produces: identical `config` object and exported types; module schemas composed via `.merge()` in `config/index.ts`; the imperative cross-field checks move to `config/index.ts` unchanged; helpers (`optionalString`, `optionalUrl`, `booleanFromEnv`) in `config/shared.ts`.

- [ ] **Step 1:** Snapshot test first: a unit test asserting a canonical env parse produces the same keys/values before and after (write against current flat schema, must still pass after the split).
- [ ] **Step 2:** Move schema keys to modules exactly as inventoried (core/ai/whatsapp/discord/band/vector/monitoring/integrations). No semantic edits — diff review must show pure moves.
- [ ] **Step 3: Full check** (suite green = behavior preserved).
- [ ] **Step 4: Commit** `refactor(config): split flat schema into modules`

---

## Task 3: App wiring — token split, persona-load log, platform-aware startup line

**Files:** Modify `src/index.ts`, `src/ai/persona.ts`. Tests: `tests/persona-name.test.ts` + extend `tests/index-platform-guard.test.ts`.

**Interfaces:**
- Produces: in `index.ts`: `monitoringToken = config.MONITORING_TOKEN ?? randomBytes(24).toString('hex')` → health server `authToken`; `loginToken = config.WHATSAPP_LOGIN_TOKEN ?? randomBytes(...)` used ONLY for the WhatsApp login handler/logging (whatsapp platform only, as gated today). When `MONITORING_TOKEN` was generated (not pinned) and metrics/admin are enabled, log one line stating ops endpoints are gated by a per-run token and how to pin. In `persona.ts`: export `getPersonaName(): string` (first `# Heading` of the loaded doc, stripped; fallback `'Garbanzo Bean'`); log `{ personaFile, platform }` at load. In `index.ts`: startup line becomes `` `${getPersonaName()} is online and listening` `` (drop the hardcoded 🫘 Garbanzo Bean).
- Consumes: T1's `MONITORING_TOKEN`.

- [ ] **Step 1: Failing tests** — `getPersonaName()` for a Remy-style doc (`# Remy - Persona Document` → `Remy`), Garbanzo doc, missing-file fallback; index: health server receives the monitoring token (not the whatsapp login token) via the existing wiring-test seams.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: PASS + full check.**
- [ ] **Step 5: Commit** `feat(ops)!: MONITORING_TOKEN gates /metrics + /admin; persona-aware startup`

---

## Task 4: Compose restructure — single file, profiles, layered env, volumes preserved

**Files:** Modify `docker-compose.yml`; delete `docker-compose.remy.yml`; modify `.gitignore` (+`.env.whatsapp`); sanity-check `docker-compose.{dev,prod,aws}.yml` still overlay. Test: `tests/compose-profiles.test.ts` (replaces `tests/remy-compose.test.ts`).

**Interfaces (the compose contract):**
- `qdrant`: `profiles: ["whatsapp", "remy"]`; volume name `garbanzo-bot-qdrant`.
- `garbanzo`: `profiles: ["whatsapp"]`; `env_file: [{path: .env}, {path: .env.whatsapp, required: false}]`; port `3001`; volumes `garbanzo-bot-auth` + `garbanzo-bot-data` + groups.json mount (all names unchanged); `extra_hosts: ["host.docker.internal:host-gateway"]`.
- `remy`: `profiles: ["remy"]`; `env_file: [{path: .env}, {path: .env.remy, required: false}]`; port `3002`; volume `garbanzo-bot-remy-data`; discord-channels.json mount; same mem limit/logging/extra_hosts as garbanzo; `MESSAGING_PLATFORM=discord`, `HEALTH_PORT=3002`, `QDRANT_COLLECTION=remy_memory` stay as service `environment:` (instance identity pinned in compose, not just env files).
- `prometheus`/`grafana`: `profiles: ["monitoring"]`; entrypoints consume `MONITORING_TOKEN` (`PROM_BEARER_TOKEN=${MONITORING_TOKEN:-}`; grafana `GRAFANA_ADMIN_PASSWORD ?? MONITORING_TOKEN`, refusal messages name `MONITORING_TOKEN`); volume names unchanged.

- [ ] **Step 1: Failing test** — parse the single file (js-yaml): per-service profiles as above; env_file layering with `required:false` on instance files; ALL six volume `name:`s byte-identical to the current values (the auth-preservation gate); no service references `WHATSAPP_LOGIN_TOKEN` in `environment:`/entrypoints; remy service exists in the base file and `docker-compose.remy.yml` is gone.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full check;** if docker present, `docker compose config -q` under each combo: `COMPOSE_PROFILES=whatsapp`, `remy`, `whatsapp,remy`, `whatsapp,remy,monitoring`.
- [ ] **Step 5: Commit** `feat(deploy)!: profile-selected single compose file with layered env`

---

## Task 5: Multi-instance monitoring — remy scrape job + dashboard job variable

**Files:** Modify `monitoring/prometheus.yml`, `monitoring/grafana/dashboards/garbanzo.json`. Test: `tests/grafana-dashboard.test.ts`.

**Interfaces:**
- prometheus: job `garbanzo` → `garbanzo:3001`, job `remy` → `remy:3002`, both `credentials_file: /prometheus/token`; comment updated to `MONITORING_TOKEN`.
- dashboard: `templating.list` gains `job` (Prometheus label_values query, multi-select, `includeAll: true`, default all); EVERY panel expr over `garbanzo_*` metrics gains `job=~"$job"` in its selector.

- [ ] **Step 1: Failing test** — parse both files: prometheus has the two jobs w/ bearer file; dashboard JSON has the `job` template var and zero `"expr"` strings containing `garbanzo_` without a `job=~` selector (regex gate — prevents regressions when panels are added).
- [ ] **Step 2: FAIL.** **Step 3: Implement** (mechanical expr edit across ~28 exprs). **Step 4: PASS + full check.**
- [ ] **Step 5: Commit** `feat(monitoring): scrape both instances; dashboard job selector`

---

## Task 6: Env examples — shared/.whatsapp/.remy layout

**Files:** Rewrite `.env.example` (shared-only: `COMPOSE_PROFILES=whatsapp` default, provider keys, `MONITORING_TOKEN` w/ comment, `QDRANT_*`/`VECTOR_*`, `APP_VERSION`, `LOG_LEVEL`, `OLLAMA_BASE_URL=http://host.docker.internal:11434` commented, `METRICS_ENABLED`); create `.env.whatsapp.example` (`OWNER_JID`, `BOT_PHONE_NUMBER`, `WHATSAPP_*` incl. `WHATSAPP_LOGIN_TOKEN` note); rewrite `.env.remy.example` as a true delta (Discord app vars, `BAND_FEATURES_ENABLED=true`, `WHISPER_URL` with host-IP note, `DISCORD_PRACTICE_CHANNEL_ID` — DROP the duplicated provider/vector/OWNER_JID lines). Test: extend `tests/compose-profiles.test.ts` with an examples-coherence check (no key appears in both shared and an instance example; `MONITORING_TOKEN` present in shared; `WHISPER_URL` present in remy).

- [ ] Steps: failing coherence test → rewrite the three files → PASS + full check (gitleaks clean — placeholders only) → **Commit** `docs(env)!: layered env examples`

---

## Task 7: Setup wizard — split-file emission + MONITORING_TOKEN + COMPOSE_PROFILES

**Files:** Modify `scripts/setup.mjs`, `scripts/setup-fields.mjs`. Test: extend `tests/setup-fields.test.ts`.

**Interfaces:**
- Produces: wizard writes `.env` (shared keys + `COMPOSE_PROFILES` derived from the chosen platform + monitoring y/n + band y/n) and `.env.whatsapp` or `.env.remy` (instance keys), backing up any it overwrites; generates a `MONITORING_TOKEN` (crypto-random) when monitoring is enabled and none exists; field table gains `MONITORING_TOKEN` (secret) and drops none. Non-interactive flags follow the existing pattern.

- [ ] Steps: failing field-resolution tests (token secret-masked, defaults, discord path emits to the instance file list) → implement (the emission split is the main surgery: `ENV_PATH` becomes per-target) → PASS + full check → **Commit** `feat(setup)!: wizard writes layered env files + monitoring token`

---

## Task 8: Docs sweep + migration guide + changelog

**Files:** README.md, docs/MONITORING.md, docs/CONFIGURATION.md, docs/REMY_DEPLOY.md (rewrite: `COMPOSE_PROFILES=remy` flow), docs/PLATFORMS.md, docs/DOCKERHUB_OVERVIEW.md, AGENTS.md Decisions Log (token model + profile model entries; retire the PR #209 Grafana note), CHANGELOG.md (`[Unreleased]` breaking section), create docs/MIGRATION-2.0.md (the owner's one-swoop checklist from the spec, incl. explicit "your WhatsApp link survives — `garbanzo-bot-auth` is untouched").

- [ ] Steps: write → link-check (paths exist) → `npm run check` (gitleaks over docs) → **Commit** `docs!: v2 deployment model, migration guide, changelog`

---

## Task 9: Whole-branch review + PR

- [ ] **Step 1:** Compile accumulated minors; whole-branch review (most capable model) with the 13-problem inventory as the coverage checklist + the auth-volume constraint as an explicit probe; fix wave if needed.
- [ ] **Step 2:** Push `feat/modular-config`; PR against main titled `feat!: modular config & profile-based deployment (v2)`. Body: problems→solutions table, breaking-changes list, migration guide pointer, test evidence. Owner merges; release cut waits for the owner's Pi migration.

---

## Self-Review

**Problems coverage:** P1 monitoring detachable (T4 profiles + T5), P2 dashboard instances (T5), P3 token overload (T1, T3, T4), P4 shared config (T4 env layering + T6), P5 OWNER_JID (T1), P6 empty-string (T1), P7 remy example gaps (T6), P8 APP_VERSION footgun (T6 docs note — single source in shared `.env`; residual awkwardness accepted), P9 fixed names (kept BY DESIGN for data continuity — constraint, not bug), P10 Ollama (T4 extra_hosts + T6), P11 QDRANT_API_KEY (T1), P12 startup/persona logs (T3), P13 wizard (T7).
**Placeholder scan:** clean — every task names exact keys/files; the dashboard edit is bounded by a regex test; OWNER_JID call-site audit is named in T1.
**Type consistency:** `MONITORING_TOKEN`, `optionalString`, `getPersonaName`, profile names `whatsapp|remy|monitoring`, env file names, and volume names are used verbatim across tasks and match the spec.
