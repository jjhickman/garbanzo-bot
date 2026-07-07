# Modular Config & Deployment — Design Spec (v2, platform-first)

**Date:** 2026-07-04
**Status:** Approved direction (owner directives incorporated; build authorized)
**Branch:** `feat/modular-config`
**Breaking:** YES — clean-slate redeploy sanctioned ("completely re-deploying everything clean in one swoop; keeping a copy of current configs/.envs"). Target version: **v2.0.0**. **HARD CONSTRAINT: every named Docker volume keeps its exact current `name:`** (`garbanzo-bot-auth`, `garbanzo-bot-data`, `garbanzo-bot-remy-data`, `garbanzo-bot-qdrant`, `garbanzo-bot-prometheus`, `garbanzo-bot-grafana`) so the linked WhatsApp auth state, both SQLite DBs, vectors, and dashboards survive the redeploy untouched. Only config/compose/env files change.

## Owner directives (govern every decision below)

1. **Discord is the first-class default platform.** It uses official, well-documented APIs. WhatsApp (Baileys, unofficial API, ToS-gray) remains fully supported but is positioned as the secondary path and labeled honestly in docs.
2. **Garbanzo is the project/framework/app name — not a persona.** "Garbanzo Bean" is just the first persona and happens to share the name. Infrastructure artifacts (compose profiles, service names, Prometheus jobs, env file names) are **platform-named** (`discord`, `whatsapp`), never persona-named (`remy` dies as an infra name).
3. **Persona names are configurable.** The bot's display identity derives from the loaded persona document, not from hardcoded strings. As few environment variables as possible — no new env var for this; the persona file is the source of truth.

## Summary

Restructure configuration and deployment so multiple platform instances (Discord + WhatsApp) run on one machine as peers, sharing one config layer, with infra (Qdrant) and monitoring (Prometheus + Grafana) attachable to any subset. Rename the overloaded ops-auth secret to `MONITORING_TOKEN`. Make the persona identity file-driven. Fold in the tracked small fixes.

Grounded in the 13-problem inventory from the codebase review. Headline findings: one token secretly does five jobs; compose `${VAR}` interpolation only ever reads the root `.env` (forcing duplication); monitoring is welded to the WhatsApp service; the Grafana dashboard has zero `job` filters so two instances' metrics blend; `OWNER_JID` is unconditionally required even on Discord; plain `.optional()` strings let `VAR=` defeat `??` fallbacks.

## Goals

1. **One compose file, profile-selected deployments.** `COMPOSE_PROFILES` in `.env` picks the shape — `discord`, `whatsapp`, `monitoring` in any combination; `docker compose up -d` starts exactly that. Qdrant starts whenever any bot profile is active. Discord-only (shipped default), WhatsApp-only, both, each ± monitoring: all first-class.
2. **Layered env files, zero duplication.** `.env` = shared (provider keys, `MONITORING_TOKEN`, Qdrant/embeddings, `APP_VERSION`, `COMPOSE_PROFILES`); `.env.discord` and `.env.whatsapp` = per-instance deltas. Services load `env_file: [.env, .env.<platform>]` (later wins); `${VAR}` interpolation naturally reads the shared file.
3. **`MONITORING_TOKEN`** gates `/metrics`, `/admin`, the Prometheus scrape credential, and the Grafana admin password (`GRAFANA_ADMIN_PASSWORD` remains an optional separate override). `WHATSAPP_LOGIN_TOKEN` shrinks to its literal job: the WhatsApp browser-login page. No cross-fallbacks.
4. **Discord is the config default.** `MESSAGING_PLATFORM` defaults to `discord`; the setup wizard lists Discord first; README/quick-start lead with Discord. WhatsApp docs carry a plain-language note that it uses an unofficial API.
5. **Modular config schema.** Split the flat ~180-line zod object into merged modules (core, ai, whatsapp, discord, band, vector, monitoring, integrations); `OWNER_JID` required only when `MESSAGING_PLATFORM=whatsapp`; every optional string treats `""` as unset.
6. **Persona identity is file-driven.** `getPersonaName()` = first `# Heading` of the loaded persona doc (fallback `"Garbanzo Bean"`). It feeds the startup line ("Remy is online and listening"), the persona-load log, and the distilled Ollama identity (name substituted into the platform-appropriate distilled text). Operators change identity by editing/mounting their persona file — documented.
7. **Multi-instance monitoring.** Prometheus scrapes both instances (`discord:3002`, `whatsapp:3001`); the Grafana dashboard gains a `job` template variable with `job=~"$job"` on every panel.
8. **Small fixes:** host-Ollama reachability (`extra_hosts` + `host.docker.internal` guidance), `QDRANT_API_KEY` empty-value crash, `.env` example rewrites (incl. `WHISPER_URL`, `METRICS_ENABLED` for Discord), wizard writes the new layout.

## Non-goals

- Per-instance metric renaming (metrics stay `garbanzo_*` — the framework name; instances distinguished by the `job` label).
- N>2 instances (layout supports it; only discord+whatsapp ship).
- Slack/Teams productization; AWS overlay rework beyond keeping it loading.
- Data migration tooling (volumes are preserved; envs hand-migrated by the owner from kept copies).
- Renaming the WhatsApp anti-ban/safety machinery or weakening its warnings — the WhatsApp path stays production-quality, just not the headline.

## Decisions

- **Profiles in ONE `docker-compose.yml`.** Services: `discord` (`profiles: ["discord"]`, container `garbanzo-discord`, port 3002, data volume name `garbanzo-bot-remy-data` — key renamed, `name:` preserved for data continuity), `whatsapp` (`profiles: ["whatsapp"]`, container `garbanzo-whatsapp`, port 3001, volumes `garbanzo-bot-auth` + `garbanzo-bot-data`), `qdrant` (`profiles: ["discord", "whatsapp"]`), `prometheus` + `grafana` (`profiles: ["monitoring"]`). `docker-compose.remy.yml` is deleted. Each bot service pins `MESSAGING_PLATFORM` explicitly in compose `environment:` (identity in infra, not just env files). `docker compose config` validation for each combo is part of the test suite.
- **Ports stay as deployed** (whatsapp 3001, discord 3002) — no churn against the owner's live volumes/dashboards.
- **`.env` is the shared layer** (compose interpolation reads only root `.env`, so shared must BE `.env`). Instance files `.env.discord` / `.env.whatsapp` load via multi-entry `env_file:` with `required: false`.
- **Token split, no fallback chain:** health-server `authToken` = `MONITORING_TOKEN` (per-run random when unset, with a log line saying how to pin). Grafana password = `GRAFANA_ADMIN_PASSWORD ?? MONITORING_TOKEN` (refuses to start when neither). Prometheus token file from `MONITORING_TOKEN`. `WHATSAPP_LOGIN_TOKEN` = login page only, whatsapp-only concern.
- **Config schema split is behavior-preserving** except the deliberate changes: `optionalString` (empty→undefined) on all plain-optional strings; `OWNER_JID` platform-conditional; `QDRANT_API_KEY` → `optionalString`; **`MESSAGING_PLATFORM` default `discord`**.
- **Persona name from the doc, zero new env vars.** `getPersonaName()` parses the loaded persona's first heading (e.g. `# Remy - Persona Document` → `Remy`; `# Garbanzo Bean` → `Garbanzo Bean`). Threaded into: startup log, persona-load log, distilled Ollama identity (name substituted; distilled personality text still platform-appropriate). Custom personas documented via bind-mount over `/app/docs/personas/<platform>.md`.
- **Prometheus scrapes both jobs statically** (`discord:3002`, `whatsapp:3001`); an inactive instance is just a down target.
- **Ollama from containers:** `extra_hosts: ["host.docker.internal:host-gateway"]` on both bot services; `OLLAMA_BASE_URL=http://host.docker.internal:11434` documented in the shared example. Default behavior unchanged when unset.

## Architecture

```
.env                    # shared: COMPOSE_PROFILES=discord (default), provider keys,
                        #   MONITORING_TOKEN, QDRANT_URL, VECTOR_*, APP_VERSION, LOG_LEVEL,
                        #   OLLAMA_BASE_URL, METRICS_ENABLED
.env.discord            # DISCORD_* app vars, BAND_FEATURES_ENABLED, WHISPER_URL,
                        #   QDRANT_COLLECTION (e.g. remy_memory), (HEALTH_PORT=3002 set in compose)
.env.whatsapp           # OWNER_JID, BOT_PHONE_NUMBER, WHATSAPP_* (incl. WHATSAPP_LOGIN_TOKEN)

docker-compose.yml      # ALL services, profile-gated (COMPOSE_PROFILES selects):
  qdrant      profiles [discord, whatsapp]   vol name garbanzo-bot-qdrant (preserved)
  discord     profiles [discord]   container garbanzo-discord   port 3002
              env_file [.env, .env.discord]  MESSAGING_PLATFORM=discord pinned
              vol name garbanzo-bot-remy-data (preserved)
  whatsapp    profiles [whatsapp]  container garbanzo-whatsapp  port 3001
              env_file [.env, .env.whatsapp] MESSAGING_PLATFORM=whatsapp pinned
              vols garbanzo-bot-auth (Baileys session — MUST keep name; owner keeps his
              linked WhatsApp across the redeploy) + garbanzo-bot-data (preserved)
  prometheus  profiles [monitoring]  scrapes discord:3002 + whatsapp:3001 w/ MONITORING_TOKEN
  grafana     profiles [monitoring]  password GRAFANA_ADMIN_PASSWORD ?? MONITORING_TOKEN

src/utils/config/       # modular schema (config.ts stays as re-export shim; call sites untouched)
  shared.ts core.ts ai.ts whatsapp.ts discord.ts band.ts vector.ts monitoring.ts integrations.ts
```

Deployment shapes (all `docker compose up -d` after setting `COMPOSE_PROFILES`):
`discord` (shipped default) · `whatsapp` · `discord,whatsapp` · any + `,monitoring`. Prod/dev overlays continue to layer on top.

## Migration (owner-facing, one swoop)

1. `docker compose down` the old stack (volumes remain, WhatsApp session included).
2. Rebuild env files from kept copies: shared values → `.env` (+ `MONITORING_TOKEN`, `COMPOSE_PROFILES=discord,whatsapp,monitoring`), old `.env.remy` values → `.env.discord` (minus the now-inherited provider/vector keys and the dead `OWNER_JID` placeholder), WhatsApp-specific values → `.env.whatsapp`.
3. `docker compose up -d`. Volumes reattach; auth, both DBs, vectors, dashboards intact.
`docs/MIGRATION-2.0.md` walks this with a checklist, including the explicit old→new env-file mapping table.

## Error handling / degradation

- Missing instance env file → `required: false` tolerates it (don't enable that profile; documented).
- `MONITORING_TOKEN` unset: bot generates per-run token (as today) → `/admin`/`/metrics` gated but unscrapeable; prometheus/grafana refuse to start with messages naming `MONITORING_TOKEN`. Metrics-off deployments unaffected.
- Config validation stays fail-fast; platform-conditional errors name the platform.

## Testing

- Schema: suite stays green; new tests for `optionalString` semantics, platform-conditional `OWNER_JID`, `MESSAGING_PLATFORM` default `discord`, `MONITORING_TOKEN` parse.
- Compose: parse-based tests — profiles per service, env_file layering (`required:false`), **all six volume `name:`s byte-identical** (the auth-preservation gate), `MESSAGING_PLATFORM` pinned per bot service, no `WHATSAPP_LOGIN_TOKEN` in monitoring entrypoints; `docker compose config -q` per profile combo when docker is available.
- Dashboard: `job` template var exists; no panel expr touches `garbanzo_*` without a `job=~` selector.
- Persona: `getPersonaName()` for Remy-style / Garbanzo-style / missing-file cases; distilled identity uses the derived name; prompt-eval set re-run (persona.ts changes).
- Wizard: field resolution + split-file emission tests.

## Docs impact

README (Discord-first quick start, `COMPOSE_PROFILES` model, WhatsApp positioned as unofficial-API path — plain register per public-copy rules), docs/PLATFORMS.md (ordering + ToS note), docs/MONITORING.md, docs/CONFIGURATION.md, docs/REMY_DEPLOY.md → superseded by the new model (band mode documented under the Discord platform docs; file replaced with a pointer or folded in), `.env.example` + `.env.discord.example` + `.env.whatsapp.example`, DOCKERHUB_OVERVIEW.md, AGENTS.md Decisions Log (platform default flip, token model, profile model, persona-name model — replaces the PR #209 Grafana note and amends "WhatsApp is production"), CHANGELOG breaking section, new docs/MIGRATION-2.0.md.

## Resolved questions (owner-directed)

1. First-class platform/default: **Discord** (`MESSAGING_PLATFORM` default, `COMPOSE_PROFILES=discord` shipped default, docs lead with it).
2. Infra naming: **platform names only** — `remy` survives solely as data (`garbanzo-bot-remy-data` volume name, `remy_memory` collection value) and as the owner's persona content.
3. Persona identity: **file-driven** via `getPersonaName()`; no new env var.
4. Version: **2.0.0**.
