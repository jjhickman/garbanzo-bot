# Modular Config & Deployment — Design Spec

**Date:** 2026-07-04
**Status:** Draft (owner reviews plan before build)
**Branch:** `feat/modular-config`
**Breaking:** YES — clean-slate redeploy sanctioned by the owner ("completely re-deploying everything clean in one swoop; keeping a copy of current configs/.envs"). Target version: **v2.0.0**. **HARD CONSTRAINT: every named Docker volume keeps its exact current `name:`** (`garbanzo-bot-auth`, `garbanzo-bot-data`, `garbanzo-bot-remy-data`, `garbanzo-bot-qdrant`, `garbanzo-bot-prometheus`, `garbanzo-bot-grafana`) so the linked WhatsApp auth state, both SQLite DBs, vectors, and dashboards all survive the redeploy untouched. Only config/compose/env files change.

## Summary

Restructure configuration and deployment so multiple platform instances (WhatsApp Garbanzo + Discord Remy) run on one machine as peers, sharing one config layer, with infra (Qdrant) and monitoring (Prometheus + Grafana) attachable to any subset. Rename the overloaded ops-auth secret to `MONITORING_TOKEN`. Fold in the tracked small fixes (empty-string env hardening, persona-load logging, platform-aware startup line, multi-instance dashboards, `.env.remy.example` gaps).

Grounded in the 13-problem inventory from the codebase review (see plan). The headline findings: one token secretly does five jobs; `${VAR}` interpolation only ever reads the root `.env` (forcing duplication); monitoring is welded to the WhatsApp service; the Grafana dashboard has zero `job` filters so two instances' metrics blend; `OWNER_JID` is unconditionally required even on Discord; plain `.optional()` strings let `VAR=` defeat `??` fallbacks.

## Goals

1. **One compose file, profile-selected deployments.** `COMPOSE_PROFILES` in `.env` picks the shape (`whatsapp`, `remy`, `monitoring` in any combination); `docker compose up -d` starts exactly that. Qdrant starts whenever any bot profile is active. Remy-only, WhatsApp-only, both, each ± monitoring — all first-class.
2. **Layered env files, zero duplication.** `.env` = shared (provider keys, `MONITORING_TOKEN`, Qdrant/embeddings, `APP_VERSION`, `COMPOSE_PROFILES`); `.env.whatsapp` and `.env.remy` = per-instance deltas. Services load `env_file: [.env, .env.<instance>]` (later wins); interpolation naturally reads the shared file.
3. **`MONITORING_TOKEN`** gates `/metrics`, `/admin`, the Prometheus scrape credential, and the Grafana admin password (with `GRAFANA_ADMIN_PASSWORD` as an optional separate override). `WHATSAPP_LOGIN_TOKEN` shrinks to its literal job: the WhatsApp browser-login page. No cross-fallbacks.
4. **Modular config schema.** Split the flat ~180-line zod object into merged modules (core, ai, whatsapp, discord, band, vector, monitoring, integrations); `OWNER_JID` required only when `MESSAGING_PLATFORM=whatsapp`; every optional string treats `""` as unset.
5. **Multi-instance monitoring.** Prometheus scrapes both instances; the Grafana dashboard gains a `job` template variable and per-panel `job=~"$job"` filters so instances can be viewed together or separately.
6. **Small fixes:** persona-load log line; platform-aware startup line ("Remy is online", not "Garbanzo Bean"); host-Ollama reachability from containers (`host.docker.internal` + `extra_hosts`); `QDRANT_API_KEY` empty-value crash; `.env.remy.example` gaps (`MONITORING_TOKEN`, `WHISPER_URL`, `METRICS_ENABLED`); setup wizard writes the new layout.

## Non-goals

- Per-instance metric renaming (metrics stay `garbanzo_*`; instances are distinguished by the Prometheus `job` label).
- Generalizing beyond two instances (the layout supports N, but only whatsapp+remy files/profiles ship).
- Slack/Teams productization; AWS overlay rework beyond keeping it loading.
- Data migration tooling (volumes are preserved; envs are hand-migrated by the owner from his kept copies).

## Decisions

- **Profiles in ONE `docker-compose.yml`, not multi-file overlays.** Now that back-compat is waived: `garbanzo` gets `profiles: ["whatsapp"]`, `remy` moves INTO the base file with `profiles: ["remy"]`, prometheus/grafana keep `profiles: ["monitoring"]`, and `qdrant` gets `profiles: ["whatsapp", "remy"]` (starts if either bot does). `docker-compose.remy.yml` is deleted. `COMPOSE_PROFILES=whatsapp,monitoring` (etc.) lives in `.env`, making deployment shape part of config — one command (`docker compose up -d`) for every shape. `docker compose config` validation for each combo is part of the test suite (extends `tests/remy-compose.test.ts`).
- **`.env` is the shared layer** (not a new `.env.shared`): compose `${VAR}` interpolation only reads the root `.env`, so the shared file must BE `.env`. Instance files are additive deltas loaded via multi-entry `env_file:` with `required: false` on instance files.
- **Token split, no fallback chain:** `MONITORING_TOKEN` (shared, ops auth) and `WHATSAPP_LOGIN_TOKEN` (whatsapp-only, login page; random per-run when unset, as today). health-server `authToken` = `MONITORING_TOKEN`. Grafana password = `GRAFANA_ADMIN_PASSWORD ?? MONITORING_TOKEN` (refuse to start if neither, as today). Prometheus token file written from `MONITORING_TOKEN`. Docs + wizard updated; `AGENTS.md` Decisions Log entry replaces the PR #209 note.
- **Config schema split is behavior-preserving** except for three deliberate changes: (1) `optionalString` (empty→undefined) applied to all plain-optional strings — kills the `DISCORD_DIGEST_CHANNEL_ID=""` class of bug globally; (2) `OWNER_JID` optional in schema + `superRefine`-required for `MESSAGING_PLATFORM=whatsapp` (Discord identity comes from `DISCORD_OWNER_ID`; the WhatsApp-shaped placeholder in `.env.remy` dies); (3) `QDRANT_API_KEY` uses `optionalString` (fixes the shipped-empty-value startup crash).
- **Prometheus scrapes both jobs statically** (`garbanzo:3001`, `remy:3002`); an inactive instance is just a down target. Simpler than templating the scrape config; revisit only if target noise ever matters.
- **Dashboard multi-instance via `job` template var** (multi-select, default all) + `job=~"$job"` on every panel expression. Combined view = today's behavior; per-instance = select one.
- **Ollama from containers:** add `extra_hosts: ["host.docker.internal:host-gateway"]` to both bot services and document `OLLAMA_BASE_URL=http://host.docker.internal:11434` in the shared example. Default stays as-is (unset = feature quietly unused, unchanged).
- **Startup identity from the persona:** derive the display name from the loaded persona doc's first `# Heading` (e.g. "Remy") with a fallback to "Garbanzo Bean"; log `"<name> is online and listening"` and log which persona file was chosen at load.

## Architecture

```
.env                    # shared: COMPOSE_PROFILES, provider keys, MONITORING_TOKEN,
                        #         QDRANT_URL, VECTOR_*, APP_VERSION, LOG_LEVEL, OLLAMA_BASE_URL
.env.whatsapp           # OWNER_JID, BOT_PHONE_NUMBER, WHATSAPP_*, (HEALTH_PORT=3001)
.env.remy               # MESSAGING_PLATFORM=discord, DISCORD_*, BAND_*, WHISPER_URL,
                        #   QDRANT_COLLECTION=remy_memory, HEALTH_PORT=3002

docker-compose.yml      # ALL services, profile-gated:
  qdrant     profiles [whatsapp, remy]     volume garbanzo-bot-qdrant (name preserved)
  garbanzo   profiles [whatsapp]  env_file [.env, .env.whatsapp]  port 3001
             vols garbanzo-bot-auth (Baileys auth — MUST keep name; owner keeps his linked
             WhatsApp session across the redeploy) + garbanzo-bot-data (preserved)
  remy       profiles [remy]      env_file [.env, .env.remy]      port 3002  vol garbanzo-bot-remy-data (preserved)
  prometheus profiles [monitoring]  scrapes garbanzo:3001 + remy:3002 w/ MONITORING_TOKEN
  grafana    profiles [monitoring]  password GRAFANA_ADMIN_PASSWORD ?? MONITORING_TOKEN

src/utils/config/       # modular schema (barrel: config.ts re-exports, call sites unchanged)
  core.ts ai.ts whatsapp.ts discord.ts band.ts vector.ts monitoring.ts integrations.ts
  shared.ts             # optionalString / optionalUrl / booleanFromEnv helpers
```

Deployment shapes (all `docker compose up -d` after setting `COMPOSE_PROFILES`):
`whatsapp` · `remy` · `whatsapp,remy` · any + `,monitoring`. Prod/dev overlays continue to layer on top.

## Migration (owner-facing, one swoop)

1. `docker compose down` the old stack (volumes remain).
2. Rebuild env files from kept copies: shared values → `.env` (+ new `MONITORING_TOKEN`, `COMPOSE_PROFILES=whatsapp,remy,monitoring`), WhatsApp-specific → `.env.whatsapp`, Remy values → `.env.remy` (drop the `OWNER_JID` placeholder, provider keys, Qdrant/embedding lines — now inherited).
3. `docker compose up -d`. Volumes reattach; WhatsApp auth, both DBs, and vectors are intact.
A `docs/MIGRATION-2.0.md` walks this with a checklist.

## Error handling / degradation

- Missing instance env file → compose `required: false` tolerates it; the profile simply shouldn't be enabled (documented).
- `MONITORING_TOKEN` unset: bot generates a per-run token (as today) → `/admin`/`/metrics` gated but unscrapeable; prometheus/grafana entrypoints refuse to start with a clear message naming `MONITORING_TOKEN`. Metrics-off deployments unaffected.
- Config validation failures keep the current fail-fast behavior with the same message quality; platform-conditional checks name the platform in the error.

## Testing

- Schema split: full existing suite must stay green (behavior-preserving); new unit tests for `optionalString` keys (`VAR=""` ≡ unset), platform-conditional `OWNER_JID`, `MONITORING_TOKEN` resolution.
- Compose: extend `tests/remy-compose.test.ts` → parse the single file; assert profiles per service, env_file layering, volume names PRESERVED (`garbanzo-bot-*`), qdrant profile union, scrape/grafana entrypoints reference `MONITORING_TOKEN` and not `WHATSAPP_LOGIN_TOKEN`; `docker compose config` run for each documented profile combo when docker is available.
- Dashboard: JSON test asserting the `job` template variable exists and every panel expr carries a `job` selector.
- Startup: persona-name extraction unit test (Remy vs Garbanzo Bean vs fallback).
- Wizard: `setup-fields`/resolver tests extended for `MONITORING_TOKEN` + split-file emission.
- Prompt-eval set untouched (no persona/tool changes beyond logging).

## Docs impact

README (quick start: `COMPOSE_PROFILES` model), docs/MONITORING.md (token rename, remy job, `$job` var), docs/CONFIGURATION.md (layered env files, new/renamed keys), docs/REMY_DEPLOY.md (rewrite: no more `-f` overlay), docs/PLATFORMS.md, `.env.example` + `.env.whatsapp.example` + `.env.remy.example`, DOCKERHUB_OVERVIEW.md, AGENTS.md Decisions Log (token model + profile model), CHANGELOG (breaking-changes section), new docs/MIGRATION-2.0.md.

## Open questions (defaults chosen; owner can redirect)

1. `COMPOSE_PROFILES` default in `.env.example` → proposing `whatsapp` (preserves the community-bot golden path for new users).
2. Version → proposing **2.0.0** (breaking config/deploy contract).
3. `docker-compose.aws.yml` → keep loading against the new base but otherwise untouched (not re-validated end-to-end).
