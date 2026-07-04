# Modular Config & Deployment (v2, platform-first) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One profile-selected `docker-compose.yml` for any combination of Discord / WhatsApp / monitoring; layered env files with a shared `.env`; `MONITORING_TOKEN` for all ops auth; modular config schema (Discord default, platform-conditional `OWNER_JID`, empty-string hardening); file-driven persona identity; multi-instance dashboards. Breaking (target v2.0.0), clean redeploy sanctioned.

**Architecture:** Spec `docs/superpowers/specs/2026-07-04-modular-config-design.md` — read its **Owner directives** section first; it governs naming everywhere. Ordering: config semantics with tests → mechanical schema split → app wiring → compose → monitoring → env examples → wizard → docs → review.

**Tech Stack:** TypeScript (ESM), Node 20+, Zod, Vitest, Docker Compose (profiles + multi-`env_file`), Prometheus/Grafana provisioning.

## Global Constraints

- **Spec** governs; its Owner directives are law: Discord first-class default; infra artifacts platform-named (`discord`/`whatsapp` — the string `remy` must not appear in service/profile/job/env-file names; it survives only as preserved data values); persona names never hardcoded into behavior — derive via `getPersonaName()`.
- **HARD CONSTRAINT — data preservation:** all six named volumes keep their exact `name:` strings (`garbanzo-bot-auth`, `garbanzo-bot-data`, `garbanzo-bot-remy-data`, `garbanzo-bot-qdrant`, `garbanzo-bot-prometheus`, `garbanzo-bot-grafana`). The owner's linked WhatsApp session lives in `garbanzo-bot-auth`. Compose tests assert these bytes.
- Breaking changes sanctioned (no back-compat shims, no token fallback chains), but behavior not named in the spec must be preserved — full suite green at every commit.
- TS strict, no `any`, ESM `.js`, Pino only, Zod for env. ~300-line file ceiling.
- **Verify env prefix:** `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter`. ALWAYS set it (existing tests assume it). New tests may use discord env where noted.
- Prompt-behavior changes (persona.ts) re-run the prompt-eval-backed tests.
- Commits `type(scope): desc` (use `!` on breaking ones), GitHub noreply author, `npm run check` before each. Never merge — push, PR, owner merges. No release/tag in this plan (owner migrates first).
- The 13-problem inventory from the exploration is coverage ground truth for the final review.

## File Structure

**Create:** `src/utils/config/` (`shared.ts`, `core.ts`, `ai.ts`, `whatsapp.ts`, `discord.ts`, `band.ts`, `vector.ts`, `monitoring.ts`, `integrations.ts`, `index.ts`), `.env.discord.example`, `.env.whatsapp.example`, `docs/MIGRATION-2.0.md`. Tests: `tests/config-hardening.test.ts`, `tests/compose-profiles.test.ts` (replaces `tests/remy-compose.test.ts`), `tests/grafana-dashboard.test.ts`, `tests/persona-name.test.ts`.
**Modify:** `src/utils/config.ts` (→ re-export shim), `src/index.ts`, `src/ai/persona.ts`, `docker-compose.yml`, `monitoring/prometheus.yml`, `monitoring/grafana/dashboards/garbanzo.json`, `.env.example`, `.gitignore`, `scripts/setup.mjs`, `scripts/setup-fields.mjs`, docs per spec, `AGENTS.md`, `CHANGELOG.md`.
**Delete:** `docker-compose.remy.yml`, `.env.remy.example` (superseded by `.env.discord.example`).

---

## Task 1: Config semantics — MONITORING_TOKEN, hardening, Discord default, conditional OWNER_JID

**Files:** Modify `src/utils/config.ts` (still flat). Test: `tests/config-hardening.test.ts`.

**Interfaces:**
- Produces: `optionalString` helper (`z.preprocess`: `''`/whitespace → `undefined`, else trimmed) applied to every plain `z.string().optional()` key (inventory: `DISCORD_DIGEST_CHANNEL_ID`, `DISCORD_RECAP_CHANNEL_ID`, `DISCORD_PRACTICE_CHANNEL_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_OWNER_ID`, `BEDROCK_MODEL_ID`, `BOT_PHONE_NUMBER`, integration API keys, `SUPPORT_MESSAGE`, `GITHUB_ISSUES_TOKEN`, `SLACK_*`, `DATABASE_URL`, `POSTGRES_*`). `QDRANT_API_KEY` → `optionalString`. New `MONITORING_TOKEN: optionalString`. `OWNER_JID` → `optionalString` + `superRefine`: required (clear error) iff `MESSAGING_PLATFORM === 'whatsapp'`. **`MESSAGING_PLATFORM` default flips `'whatsapp'` → `'discord'`.**
- Call-site audit is part of this task: every `config.OWNER_JID` consumer handles `string | undefined` explicitly (whatsapp paths run under the platform guarantee; discord demo/interactions fallbacks use `?? getDiscordOwnerId() ?? ''`-style explicit handling; no `!`). Audit anything assuming the old whatsapp default (e.g. bare-config tests, `src/platforms/index.ts` selection) — tests always set `MESSAGING_PLATFORM` explicitly, so runtime code should be the only concern.

- [ ] **Step 1: Failing tests** — `VAR=''` ≡ unset for digest/recap channel ids + `QDRANT_API_KEY`; `MONITORING_TOKEN` parsed; bare env (no `MESSAGING_PLATFORM`) → `discord` + parses WITHOUT `OWNER_JID`; `whatsapp` without `OWNER_JID` → fail-fast with the named error; `whatsapp` with it → ok. (Fresh-module config-test pattern: `vi.resetModules()` + env seeding.)
- [ ] **Step 2: RED.** **Step 3: Implement + call-site audit.** **Step 4: GREEN + full check.**
- [ ] **Step 5: Commit** `feat(config)!: discord default, MONITORING_TOKEN, empty-string hardening, conditional OWNER_JID`

---

## Task 2: Config schema split into modules (mechanical)

**Files:** Create `src/utils/config/*.ts` per the spec's module map; `src/utils/config.ts` becomes a re-export shim (`export { config, ... } from './config/index.js'`) so call sites are untouched. Helpers to `config/shared.ts`; imperative cross-field checks move verbatim to `config/index.ts`.

- [ ] **Step 1:** Write the parity test FIRST against the flat schema (canonical env → snapshot of parsed keys/values); it must pass unchanged after the split.
- [ ] **Step 2:** Move keys to modules exactly per the spec map — pure moves, zero semantic edits (reviewer verifies diff is move-only).
- [ ] **Step 3: Full check green.** **Step 4: Commit** `refactor(config): split flat schema into modules`

---

## Task 3: App wiring — token split + file-driven persona identity

**Files:** Modify `src/index.ts`, `src/ai/persona.ts`. Tests: `tests/persona-name.test.ts`, extend `tests/index-platform-guard.test.ts` + `tests/persona-formatting.test.ts`.

**Interfaces:**
- `index.ts`: `monitoringToken = config.MONITORING_TOKEN ?? randomBytes(24).toString('hex')` → health server `authToken`. `loginToken = config.WHATSAPP_LOGIN_TOKEN ?? randomBytes(...)` used ONLY by the WhatsApp login handler/logging (existing platform gate). When metrics/admin enabled and `MONITORING_TOKEN` was generated (not pinned): one log line explaining ops endpoints are gated by a per-run token and to pin `MONITORING_TOKEN`. Startup line becomes `` `${getPersonaName()} is online and listening` `` (hardcoded 🫘 Garbanzo Bean dies).
- `persona.ts`: export `getPersonaName(): string` — first markdown `# Heading` of the LOADED persona doc, stripped of decoration (`# Remy - Persona Document` → `Remy`; `# Garbanzo Bean — persona` → `Garbanzo Bean`); fallback `'Garbanzo Bean'` when no doc/heading. Log `{ personaFile, platform }` once at load. `buildDistilledIdentityBlock` (Ollama) substitutes `getPersonaName()` for the hardcoded names in both platform branches (personality text stays platform-appropriate).
- Docs note (folded into T8): custom persona = bind-mount over `/app/docs/personas/<platform>.md`.

- [ ] **Step 1: Failing tests** — `getPersonaName()` cases above; distilled Ollama prompt contains the derived name (and not a hardcoded one when a custom doc is mocked); health server receives the monitoring token (not the login token) via the existing seams; whatsapp login path still uses `WHATSAPP_LOGIN_TOKEN`.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN + full check + prompt-eval tests.**
- [ ] **Step 5: Commit** `feat(ops)!: MONITORING_TOKEN gates ops endpoints; persona identity from the persona doc`

---

## Task 4: Compose restructure — single file, platform profiles, layered env

**Files:** Rewrite `docker-compose.yml`; DELETE `docker-compose.remy.yml`; `.gitignore` += `.env.discord`, `.env.whatsapp`; verify `docker-compose.{dev,prod,aws}.yml` still overlay (service-name updates where they reference `garbanzo`). Test: `tests/compose-profiles.test.ts` (replaces `tests/remy-compose.test.ts`).

**Interfaces (the compose contract):**
- `qdrant`: `profiles: ["discord", "whatsapp"]`; volume name `garbanzo-bot-qdrant`.
- `discord`: `profiles: ["discord"]`; `container_name: garbanzo-discord`; `env_file: [{path: .env, required: true}, {path: .env.discord, required: false}]`; `environment:` pins `MESSAGING_PLATFORM=discord`, `HEALTH_PORT=3002`; port `127.0.0.1:3002:3002`; volume key `discord_data` with **`name: garbanzo-bot-remy-data`**; discord-channels.json ro-mount; 1G mem limit; logging like today; `extra_hosts: ["host.docker.internal:host-gateway"]`; `depends_on: qdrant`.
- `whatsapp`: `profiles: ["whatsapp"]`; `container_name: garbanzo-whatsapp`; `env_file: [{path: .env, required: true}, {path: .env.whatsapp, required: false}]`; `environment:` pins `MESSAGING_PLATFORM=whatsapp`, `HEALTH_PORT=3001`; port `0.0.0.0:3001:3001` (as today); volumes **`garbanzo-bot-auth`** + `garbanzo-bot-data` + groups.json mount; existing mem limit/logging; `extra_hosts` likewise; `depends_on: qdrant`.
- `prometheus`/`grafana`: `profiles: ["monitoring"]`; entrypoints consume `MONITORING_TOKEN` (`PROM_BEARER_TOKEN=${MONITORING_TOKEN:-}`; grafana `GRAFANA_ADMIN_PASSWORD ?? MONITORING_TOKEN`; refusal messages name `MONITORING_TOKEN`); volume names unchanged. (Scrape targets updated in T5; this task may stage the prometheus.yml target rename together with the service rename to keep the tree consistent — coordinate, don't leave `garbanzo:3001` dangling.)

- [ ] **Step 1: Failing test** (js-yaml parse): per-service profiles exactly as above; env_file layering incl. `required:false`; ALL SIX volume `name:`s byte-identical; `MESSAGING_PLATFORM` pinned per bot service; zero `WHATSAPP_LOGIN_TOKEN` references anywhere in the file; no service or profile named `remy`; `docker-compose.remy.yml` absent.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN + full check;** if docker available: `docker compose config -q` under `COMPOSE_PROFILES=discord`, `whatsapp`, `discord,whatsapp`, `discord,whatsapp,monitoring`.
- [ ] **Step 5: Commit** `feat(deploy)!: platform-profile compose with layered env files`

---

## Task 5: Multi-instance monitoring — both scrape jobs + dashboard job variable

**Files:** Modify `monitoring/prometheus.yml`, `monitoring/grafana/dashboards/garbanzo.json`. Test: `tests/grafana-dashboard.test.ts`.

**Interfaces:**
- prometheus: `job_name: discord` → `discord:3002`; `job_name: whatsapp` → `whatsapp:3001`; both bearer `credentials_file: /prometheus/token`; comments name `MONITORING_TOKEN`; the old `garbanzo` job/target is gone.
- dashboard: `templating.list` gains `job` (label_values, multi-select, `includeAll: true`, current=All); every panel expr over `garbanzo_*` metrics carries `job=~"$job"`.

- [ ] **Step 1: Failing test** — prometheus parse: exactly the two platform jobs w/ bearer file, no `garbanzo:3001`; dashboard JSON: `job` template var present; regex gate: zero `"expr"` containing `garbanzo_` without `job=~` (guards future panels).
- [ ] **Step 2: RED.** **Step 3: Implement** (mechanical across ~28 exprs). **Step 4: GREEN + full check.**
- [ ] **Step 5: Commit** `feat(monitoring): per-platform scrape jobs + dashboard job selector`

---

## Task 6: Env examples — shared / .discord / .whatsapp

**Files:** Rewrite `.env.example` (shared only: `COMPOSE_PROFILES=discord` default with the other shapes commented, provider keys, `MONITORING_TOKEN` + comment, `QDRANT_*`/`VECTOR_*`, `APP_VERSION`, `LOG_LEVEL`, `METRICS_ENABLED`, commented `OLLAMA_BASE_URL=http://host.docker.internal:11434`); create `.env.discord.example` (Discord app vars, `BAND_FEATURES_ENABLED`, `WHISPER_URL` with host-IP note, `DISCORD_*_CHANNEL_ID`s, `QDRANT_COLLECTION` example) and `.env.whatsapp.example` (`OWNER_JID`, `BOT_PHONE_NUMBER`, `WHATSAPP_*` incl. `WHATSAPP_LOGIN_TOKEN` scoped note); DELETE `.env.remy.example`. Test: extend `tests/compose-profiles.test.ts` — examples coherence (no key in both shared and an instance example; `MONITORING_TOKEN` in shared; `WHISPER_URL` in discord; `OWNER_JID` NOT in shared or discord).

- [ ] Steps: failing coherence test → rewrite/create/delete → GREEN + full check (gitleaks: placeholders only) → **Commit** `docs(env)!: layered env examples, discord-first`

---

## Task 7: Setup wizard — split emission, MONITORING_TOKEN, Discord-first

**Files:** Modify `scripts/setup.mjs`, `scripts/setup-fields.mjs`. Test: extend `tests/setup-fields.test.ts`.

**Interfaces:**
- Wizard platform menu lists **Discord first** (default selection), WhatsApp second with an "unofficial API" parenthetical. Writes `.env` (shared keys + `COMPOSE_PROFILES` derived from platform choice + monitoring y/n) and `.env.discord` or `.env.whatsapp` (instance keys), backing up files it overwrites. Generates a crypto-random `MONITORING_TOKEN` when monitoring enabled and none supplied. Field table gains `MONITORING_TOKEN` (secret-masked). Non-interactive flags follow the existing pattern.

- [ ] Steps: failing field/emission tests (token masked; discord default; keys routed to the right file) → implement (`ENV_PATH` becomes per-target emission) → GREEN + full check → **Commit** `feat(setup)!: discord-first wizard writes layered env files`

---

## Task 8: Docs sweep, migration guide, changelog, decisions log

**Files:** README.md (Discord-first quick start, `COMPOSE_PROFILES` model, WhatsApp = supported-but-unofficial note — plain register, no AI-copy tells), docs/PLATFORMS.md (ordering + ToS honesty), docs/MONITORING.md (token + `$job`), docs/CONFIGURATION.md (layered env, renamed/new keys), docs/REMY_DEPLOY.md → replaced with a short pointer into the new model (band mode = `.env.discord` + `BAND_FEATURES_ENABLED`), docs/DOCKERHUB_OVERVIEW.md, AGENTS.md Decisions Log (platform default flip amending "WhatsApp is production"; token model replacing the PR #209 note; profile model; persona-name model), CHANGELOG `[Unreleased]` breaking section, create docs/MIGRATION-2.0.md (one-swoop checklist + old→new env mapping table + "your WhatsApp link survives: `garbanzo-bot-auth` untouched"), docs/ROADMAP.md — add the owner-approved post-v2 entry: v3 platform bridging, Tier 1 (cross-instance shared memory with scoping) + Tier 2 (bridge-map message relay; Discord→WhatsApp relays flow through the outbound-safety layer), explicitly gated on v2.0.0 being deployed and observed stable; Tier 3 (single-process multi-runtime) deferred.

- [ ] Steps: write → verify every referenced path/command against the implemented tree → `npm run check` → **Commit** `docs!: discord-first v2 deployment model + migration guide`

---

## Task 9: Whole-branch review + PR

- [ ] **Step 1:** Compile accumulated minors; whole-branch review (most capable model) probing: 13-problem coverage, the six volume-name bytes, no `remy`-named infra, no hardcoded persona names in behavior paths, WhatsApp path untouched functionally, docs/commands truthful against the tree.
- [ ] **Step 2:** Fix wave if needed; push; PR `feat!: platform-first modular config & deployment (v2)` — problems→solutions table, breaking list, migration pointer, test evidence. Owner merges; release cut deferred until the owner's Pi migration.

---

## Self-Review

**Problems coverage:** P1→T4+T5, P2→T5, P3→T1/T3/T4, P4→T4/T6, P5→T1, P6→T1, P7→T6, P8→T6 docs note (single-source `APP_VERSION` in shared `.env`), P9→kept by design (data continuity), P10→T4+T6, P11→T1, P12→T3, P13→T7. Owner directives: Discord default (T1/T4/T6/T7/T8), platform naming (T4/T5/T6), persona configurability (T3/T8).
**Placeholder scan:** clean — exact keys/files/strings named per task; dashboard bounded by a regex gate; OWNER_JID call-site audit named in T1; cross-task compose/prometheus rename coordination called out in T4.
**Type consistency:** `MONITORING_TOKEN`, `optionalString`, `getPersonaName`, profiles/services `discord|whatsapp|monitoring`, env files `.env`/`.env.discord`/`.env.whatsapp`, volume names, and container names `garbanzo-discord`/`garbanzo-whatsapp` are used verbatim across tasks and match the spec.
