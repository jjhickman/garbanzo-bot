# Changelog
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


All notable changes to Garbanzo are documented here.

## [Unreleased]

## [3.2.0] — 2026-07-07

Adoption release: Garbanzo now runs without Docker, from a guided setup to a
system service, on a single always-on machine.

### Added

- No-Docker deployment path: `docs/QUICKSTART.md` walks a single-instance
  setup end to end. The README Quick Start now offers both doors (bare Node
  and the full Docker stack).
- `garbanzo` CLI (`dist/cli.js`): `setup` (spawns the wizard), `start`,
  `doctor` (environment report: mode, config presence, optional binaries,
  provider key presence, health-port availability, current vs latest
  version), and `service install|uninstall` (systemd/launchd generation with
  resolved paths; refuses ephemeral npx caches; never invokes systemctl
  itself).
- npm packaging as `garbanzo-bot` with a `garbanzo` bin: shipped assets
  (wizard, personas, config examples, service template), a packaged-install
  sentinel so mutable state resolves to `~/.garbanzo`, a blocking pack
  rehearsal in CI that installs the tarball and boots it, and a tag-triggered
  publish workflow (skips with a notice until an `NPM_TOKEN` secret exists).
- `GARBANZO_HOME`: mutable state (database, WhatsApp auth, config JSON, env
  files, persona overrides) resolves to an explicit home directory —
  repo/Docker deployments are unchanged; npm installs default to
  `~/.garbanzo`.
- `save_community_memory` AI tool: the bot can now save a community fact when
  someone explicitly asks it to remember something, instead of only searching
  existing memory. Saves are validated (category and length), deduplicated
  against existing facts, rate-limited per process window, tagged with an
  `ai-tool` source visible in `!memory list` as `(ai)`, and never enter the
  shared cross-instance collection.
- CI smoke matrix boots the built app on Windows and macOS (non-blocking;
  Windows is experimental this release).

### Changed

- The setup wizard is native-first: a complete Discord walkthrough (portal
  steps, generated invite URL, required intents), hard-gated credentials and
  channel with snowflake validation, no `COMPOSE_PROFILES` written on the
  native path, keyword memory (`VECTOR_STORE=none`) as the native default,
  and merge semantics for existing channel configs on re-run.
- `config/groups.json` loads fail-soft: a missing file yields an empty groups
  config with a warning instead of crashing startup; malformed files log the
  path and reason.
- `QDRANT_URL` defaults to `http://127.0.0.1:6333`. Docker Compose and the
  Helm chart pin the in-cluster hostname explicitly (operator `.env`
  overrides still win), so containerized deployments are unaffected.
- Media integrations (ffmpeg, yt-dlp, Piper) run via argument arrays instead
  of shell strings; behavior is unchanged and Windows-compatible.

### Fixed

- Blank `KEY=` lines in env files no longer fail validation for bridge and
  shared-memory settings; empty values fall back to defaults.
- Short "remember that..." messages route to a tool-capable model instead of
  the local fallback, which cannot save memories and now says so.

## [3.1.0] — 2026-07-07

### Added

- `WHATSAPP_CHAT_SCOPE=configured` lets a WhatsApp linked-device instance ingest only groups enabled in its own `config/groups.json`, while DMs still flow for owner commands.
- `WHATSAPP_SET_PROFILE_NAME=false` disables account-level profile-name updates on secondary WhatsApp linked-device instances.
- Docs now cover same-account WhatsApp companion-device bridge deployments, the hard-isolation second-number option, and 3.x candidate follow-ups.

## [3.0.0] — 2026-07-06

### Added

- Cross-platform bridging (`BRIDGE_ENABLED`, default off): message relay between mapped Discord channels and WhatsApp groups defined in `config/bridge-map.json`, with a durable per-instance outbox, `http` and `amqp` (RabbitMQ) transports, and a receiver endpoint at `/bridge/inbound` on the health port.
- Shared community memory across instances (`SHARED_MEMORY_ENABLED`, default off): `!memory share <id>` / `!memory unshare <id>` explicitly copy a curated fact into a dedicated shared Qdrant collection (`QDRANT_SHARED_COLLECTION`), namespaced by instance id.
- `INSTANCE_ID` config key for deployment identity, used by bridge routes, shared-fact ids, and metrics; defaults to `MESSAGING_PLATFORM` so existing deployments are unaffected.
- `senderName` attribution plumbed into inbound messages on WhatsApp and Discord, so relayed messages show `Name (Platform): ...`.
- A bounded cross-platform markdown translator for relayed text (bold/italic/strike/monospace only).
- Optional `broker` Docker Compose profile (RabbitMQ) for the amqp bridge transport, gated on `BRIDGE_BROKER_PASSWORD`.

See [docs/BRIDGING.md](docs/BRIDGING.md) for setup. Everything above is additive and off by default; no action is needed to upgrade an existing deployment.

## [2.0.0] — 2026-07-06

### Breaking changes

- Docker Compose now uses platform profiles in one file. Set `COMPOSE_PROFILES` and migrate to `.env`, `.env.discord`, and `.env.whatsapp` before deploying v2.
- `MONITORING_TOKEN` replaces the old monitoring/admin use of `WHATSAPP_LOGIN_TOKEN`. The old fallback behavior is gone; `WHATSAPP_LOGIN_TOKEN` now gates only the WhatsApp login page.
- `MESSAGING_PLATFORM` now defaults to `discord`.
- Env loading is layered. Shared values live in `.env`; platform-specific values live in `.env.discord` and `.env.whatsapp`.
- The setup wizard now writes the split env-file layout instead of a single all-in-one env file.

### Added

- Persona-file identity: startup and prompt identity derive from the loaded persona document through `getPersonaName()`.
- Native env layering through the config loader, matching Docker Compose env file order.
- Grafana `$job` dashboard filtering for viewing Discord and WhatsApp instances together or one at a time.
- Host Ollama support for containers through `host.docker.internal` extra hosts.

### Changed

- Discord is the default platform path in docs, setup, and config examples.
- Band mode runs on the Discord compose profile with `.env.discord` and `BAND_FEATURES_ENABLED=true`.
- Prometheus scrapes both platform jobs: `discord:3002` and `whatsapp:3001`.

## [1.1.0] — 2026-07-04

### Added

- Discord runs a real Gateway connection (discord.js), so the bot observes and responds to channel messages, welcomes members, runs scheduled digests and recaps, and escalates to the owner by DM. Configure per-channel behavior and band roles in `config/discord-channels.json`.
- Self-hosted Qdrant vector memory for semantic recall of community facts. `VECTOR_STORE=qdrant` by default and falls back to keyword search when Qdrant is unavailable; `VECTOR_STORE=none` keeps keyword-only.
- Remy band-assistant features, all gated behind `BAND_FEATURES_ENABLED` (default off, so the WhatsApp community bot is unaffected):
  - Song catalog (`!song`) with key, tempo, and status.
  - Practice tools: rehearsals with reminders (`!rehearsal`), availability (`!available`), setlists (`!setlist`), and a practice agenda (`!agenda`).
  - Songwriting: idea capture from text or a dropped audio clip transcribed via Whisper (`!idea`), and per-song sections, lyrics, and chords (`!section`, `!lyrics`).
- Legacy Remy compose overlay support for running Remy beside Garbanzo on one host, and setup wizard support for provisioning a Discord deployment.

### Changed

- pgvector support removed in favor of Qdrant as the single vector store.

## [1.0.7] — 2026-07-03

### Added

- Firecrawl is now the top-priority `web_search` provider with extracted page-content results, plus a larger `web_search` tool-result budget for direct answers from scraped content.


## [1.0.6] — 2026-07-03

### Fixed

- The model now prefers `web_search` (and other tools) over training-data answers for factual questions: tool-use directive added to the system prompt and the `web_search` tool description made prescriptive.

## [1.0.5] — 2026-07-03

### Added

- `web_search` AI tool with a reusable multi-provider wrapper (Brave default; Google Programmable Search and SearXNG supported via env vars).

## [1.0.4] — 2026-07-02

### Changed

- Grafana admin login defaults to the pinned `WHATSAPP_LOGIN_TOKEN` (one secret for the whole stack; `GRAFANA_ADMIN_PASSWORD` remains an optional override) — documented as a deliberate single-owner tradeoff.
- README and Docker Hub overview/short-description refreshed for the 1.0.x feature set (tool calling, auto-memory, reminders, recaps, observability stack, GPT-5 Responses API, Baileys v7).


## [1.0.3] — 2026-07-02

### Added

- Community/admin Prometheus metric families for lifetime activity, daily group gauges, memory facts, pending/sent event reminders, rate-limit rejections, tool-call outcomes, and AI cost/request/error totals.
- Bearer auth support for `/metrics` and `/admin`, alongside the existing query-token flow.
- Self-hosted Prometheus + Grafana monitoring stack.

## [1.0.2] — 2026-07-02

### Fixed

- **OpenAI tool calling with GPT-5-family models** — the OpenAI API-key path now uses the Responses API (`/v1/responses`) with full function-tool and `reasoning.effort` support. OpenAI remains the default primary provider (`openai,anthropic`).


## [1.0.1] — 2026-07-02

### Fixed

- **OpenAI GPT-5-family request shape** — the chat/completions path sent `max_tokens`, which GPT-5-series/o-series reasoning models reject; they now get `max_completion_tokens` plus an explicit `reasoning_effort` (new env `OPENAI_REASONING_EFFORT`, default `low`) so hidden reasoning-token spend is bounded. Older OpenAI models and the OpenRouter path keep `max_tokens`; the OAuth path is untouched.

## [1.0.0] — 2026-07-02

First stable release. Every item below shipped as an individually reviewed PR (#183–#202) and runs in production on a Raspberry Pi 5.

### Added

- **Native LLM tool calling** (opt-in, `AI_TOOL_CALLING`) — the model invokes weather/transit/venues/news/books/community-memory tools mid-response for Anthropic, OpenAI, and OpenRouter; bounded tool loop under the existing circuit breaker (#198).
- **Automatic community memory** (opt-in, `MEMORY_AUTO_EXTRACT`) — async post-reply fact extraction with dedup, caps, `(auto)` tagging, and `!memory` curation (#195).
- **Event reminders** — confidently-parsed event proposals persist and the chat gets a "starts soon" nudge; `!events` owner commands (#201).
- **Weekly community recap** — `!recap` + scheduled Sunday owner DM aggregating the archived daily digests (#200).
- **Owner admin page** — token-gated `/admin` + `/admin.json`: daily AI spend vs. threshold, provider mix, per-group activity, outbound-safety counters (#196).
- **Message-edit awareness** — edits re-run moderation and intro classification; editing a message can no longer dodge moderation (#199).
- **Host backups** — nightly systemd-timer archive of the WhatsApp auth + data volumes to external storage, with verification, retention, and a one-command restore (#191).
- **Watchtower option** — documented label-filtered auto-update path with pinned-vs-latest guidance (#193).
- `OLLAMA_MODEL` env var + Raspberry Pi local-inference guide (gemma3:1b-class models) (#197).
- `RETRY_ATTEMPT_TIMEOUT_MS` optional per-attempt retry bound (#192).

### Fixed

- **Owner commands ignored for LID senders** — inbound senders resolve LID→phone JID; owner match tolerates device suffixes; rate-limit exemption restored (#190).
- **OpenAI OAuth mode never worked** — the private Responses backend is SSE-only; the OAuth path now streams and parses events (verified against a live token). Still experimental/ToS-grey and fallback-protected (#194).
- Router race conditions (Ollama availability cache, midnight cost-alert reset), Slack refresh regression coverage, structured pre-logger config errors (#192).
- WhatsApp linking/reconnect: 515 (restartRequired) and 428 (connectionClosed) reconnect instead of pausing (#183, #185).
- `node_modules/` gitignore pattern also matches symlinks now; a stray committed symlink was removed.

### Changed

- **Baileys 7.0.0-rc13 + baileys-antiban 4.10.0** — LID-era upgrade; v7 alt-field message keys with v6 fallbacks; auth state migrates in place (back up first — see docs/BACKUPS.md) (#202).
- Model defaults modernized: `claude-haiku-4-5` / `gpt-5.4-mini`, env-driven pricing, Anthropic prompt caching, provider order `anthropic,openai` (#188).
- WhatsApp anti-ban warm-up defaults raised to 2000/day and documented (#187).
- README restructured (887 → 259 lines) with reference docs extracted to docs/ (#186); new docs: BACKUPS, CONFIGURATION, PLATFORMS, CUSTOMIZATION, PHILOSOPHY.
- 665 tests (from 609 at v0.2.4).


## [0.1.9] — 2026-02-17

### Added

- **Session memory (Phase 1)** — 30-minute gap sessionization, extractive summarization, session retrieval in prompt context, ROI metrics in stats/digest, config flags (`CONTEXT_SESSION_*`).
- **Vector memory (Phase 2)** — contextualized embedding headers, OpenAI `text-embedding-3-small` provider with deterministic fallback, session embedding backfill job, lightweight post-retrieval reranker, offline eval harness with synthetic QA set and recall@K metrics.
- **Embedding provider router** (`src/utils/embedding-provider.ts`) — graceful fallback from OpenAI to deterministic embeddings; logged once per provider to avoid log spam.
- **Embedding pipeline metrics** — provider breakdown, latency, fallback counts exposed in stats and digest.
- **Unified demo server** — single-service app at `garbanzobot.com` with model transparency UI, platform switcher (Slack/Discord), and Turnstile protection.
- **Slack professional persona** (`docs/personas/slack.md`) loaded at runtime for Slack-mode responses.
- **CDK demo embedding overrides** — `demoVectorEmbeddingProvider`, `demoVectorEmbeddingModel` stack parameters; demo defaults to OpenAI embeddings.
- **Feature API key wiring in CDK/preflight** — `featureSecretArn` support for GOOGLE_API_KEY, MBTA_API_KEY, NEWSAPI_KEY, BRAVE_SEARCH_API_KEY in ECS task definitions.
- 20 new tests across 7 files (reranker, eval harness, session backfill, contextualized embeddings, embedding provider router, unified demo server, Postgres session retrieval); **509 tests total**.

### Fixed

- Postgres runtime schema availability enforced in Docker image (`postgres-schema.sql` copied into runtime).
- Resolved high-severity `fast-xml-parser` DoS advisory (GHSA-jmr7-xgp7-cmfj) via npm override to `>=5.3.6`.

### Changed

- README updated with session memory features, Postgres/pgvector in Stack section, 19 new env vars, test count 509+, docs index entries, unified demo, and Slack persona.
- Docker Hub overview updated with session memory, Bedrock provider, Postgres storage, version bumped to 0.1.9.
- Website updated with session memory card, Bedrock provider, Postgres/pgvector storage.
- `gitleaks` allowlist now excludes `cdk.out/` to prevent false positives from CDK synth output.

## [0.1.8] — 2026-02-16

### Changed

- Switched project licensing to Apache License 2.0 and updated package metadata accordingly.
- Reworked licensing docs to reflect Apache-2.0 commercial-use permissions and optional paid support/services.
- Updated README, website footer, and Docker Hub overview copy for Apache-2.0 licensing language.

## [0.1.7] — 2026-02-16

### Added

- Added member-safe release communication controls with `!release rules`, preview-first send flow, operator-only internal notes, and force override support in `!release` command handling.
- Added release checklist requirements for website deployment verification and release-preview approval before member broadcasts.
- Added support tier messaging and CTA structure updates to website configuration for Patreon/Sponsors alignment.

### Changed

- Setup wizard now supports Slack demo mode configuration (`--platform=slack --slack-demo=true`) and writes `SLACK_DEMO*` env settings.
- Setup completion messaging now explicitly clarifies platform status (WhatsApp support, Slack demo local-only, Discord/Teams pending).
- Added script-level coverage for Slack setup dry-run behavior to keep setup output deterministic and regression-safe.
- Added `npm run release:checklist` helper to create and assign release checklist issues using the protected-`main` workflow.
- Added a rollback playbook to `docs/RELEASES.md` and linked it from the release checklist template.
- Added `npm run release:deploy:verify` helper to deploy a target tag, verify health/readiness, and optionally auto-rollback.
- `release:deploy:verify` now accepts both `--flag value` and `--flag=value` forms for safer CLI usage in scripts.
- Added an AWS CDK static-site stack (`GarbanzoSiteStack`) to publish `website/` to S3 + CloudFront.
- Added local Discord demo runtime (`DISCORD_DEMO`) with HTTP simulation and parity tests, mirroring the Slack demo pattern.
- Added explicit Gemini integration coverage tests (`tests/gemini.test.ts`) and updated README provider docs to include Gemini configuration and pricing fields.
- Added optional custom-domain support to the static-site stack (`siteDomainName` + `siteHostedZoneId`).
- Added GitHub Actions static-site deploy workflow (`deploy-support-site.yml`) for website/CDK site changes.
- Updated website content and README positioning to reflect multi-platform chat operations posture and sustainable support options.
- Updated release docs and owner help text to use preview-before-send defaults for member updates.
- Updated product roadmap/docs messaging to keep public guidance reusable and internal strategy private.
- Hardened GitHub Actions AWS deploy role assumptions to least privilege for static-site automation.

> Note: older changelog sections include internal phase milestones that predate the current tagged release series.

## [0.1.6] — 2026-02-16

### Added

- Docker release workflow now includes a report-only Trivy image scan artifact (`trivy-image-report`) for published GHCR images.
- Lightweight operations helpers added for log and host hardening tasks:
  - `npm run logs:scan` (Pino JSON log summarizer)
  - `npm run logs:journal` (systemd user journal helper)
  - `npm run host:lynis` (Lynis audit helper)
  - `npm run host:fail2ban` (fail2ban SSH jail bootstrap helper)
- Added `tests/scripts.test.ts` to cover core CLI behavior for the new operations scripts.

### Changed

- `npm run check` now includes dependency vulnerability scanning via `npm audit --audit-level=high`.
- Host hardening helper scripts now provide clearer sudo messaging in non-interactive shells.
- ROADMAP test-suite references were refreshed to align with current suite size.

## [0.1.5] — 2026-02-16

### Fixed

- Native-binary release workflow now checks out the repo before running `gh release create --generate-notes` (prevents "not a git repository" failures)
- Quoted-media extraction now includes `remoteJid` when downloading quoted media via Baileys

### Changed

- Small WhatsApp adapter cleanup (drop redundant delete key cast)

## [0.1.4] — 2026-02-16

### Added

- Release workflows now auto-create GitHub Release pages with generated notes before attaching assets (Docker + native binaries)
- Slack demo runtime outbox now includes `replyToId` and `threadId` to inspect reply/thread behavior

### Changed

- `MessageRef` is now a structured wrapper and WhatsApp stores minimal ref data (key + optional message) instead of full Baileys message objects
- Poll payload is typed (`PollPayload`) and explicitly mapped into the Baileys poll message shape

### Fixed

- Release flow documentation/tooling now reflects protected `main` behavior (merge via PR; tag `main`; push tag)
- Added tests to cover WhatsApp quote/delete behavior and Slack demo thread propagation

## [0.1.3] — 2026-02-16

### Removed

- Archived legacy stack artifacts and external comparison docs (repo is now fully self-contained and brand-consistent)

### Changed

- Docs reframed to focus on Garbanzo's own operational posture (smaller surface area, curated features, explicit health semantics, local-first state, CI guardrails)
- Release tooling no longer treats `archive/` as a release artifact directory

## [0.1.2] — 2026-02-15

### Added

- **Slack demo runtime (local-only)** — run `MESSAGING_PLATFORM=slack` with `SLACK_DEMO=true` to exercise the core pipeline without Slack APIs (HTTP `/slack/demo` endpoint)

### Fixed

- **Readiness sticking stale after reconnect** — `/health/ready` no longer returns 503 with `stale=true` immediately after a successful WhatsApp reconnect
- **CI sqlite flakiness** — Vitest workers now use per-process sqlite DB paths under `os.tmpdir()` to avoid `SQLITE_BUSY` / WAL contention

### Changed

- **Core/platform refactor** — core inbound and group processing lives under `src/core/*`; WhatsApp runtime and platform-specific helpers live under `src/platforms/whatsapp/*`
- **Docs** — README and architecture docs updated to match current layout; Docker Hub overview updated with troubleshooting notes

## [0.1.1] — 2026-02-14

### Added

- Initial tagged release of Garbanzo.

### Notes

- The feature set that existed prior to the first tag is captured under "Historical Milestones" below.

## Historical Milestones (pre-tag)

### Phase 4 milestone — 2026-02-13

### Added — Phase 4: Growth Features
- **D&D 5e** — `!roll` dice rolling (any notation), `!dnd spell/monster/class/item` SRD lookups via dnd5eapi.co
- **Character sheet generator** — `!character [race] [class]` creates Level 1-20 D&D characters, fills official WotC PDF template (3 pages), supports named characters, alignment, background, free-form description
- **Book club** — `!book` search, author lookup, ISBN details via Open Library API
- **Venue search** — `!venue` search + details via Google Places API, Boston default
- **Polls** — `!poll Question / A / B / C` creates native WhatsApp polls (1-12 options, multi-select)
- **Fun features** — `!trivia`, `!fact`, `!today`, `!icebreaker` (40 Boston-themed icebreakers)
- **Feedback system** — `!suggest`, `!bug`, `!upvote` for member submissions; `!feedback` owner review

### Phase 3 milestone — 2026-02-13

### Added — Phase 3: Intelligence Layer
- **Ollama routing** — simple queries routed to local qwen3:8b, complex to Claude; auto-fallback
- **Conversation context** — SQLite-backed, last 15 messages per group as AI context
- **Daily digest** — auto-scheduled 9 PM summary to owner DM; `!digest` preview
- **Rate limiting** — per-user (10/5min) and per-group (30/5min) sliding window, owner exempt
- **Bang command routing** — `!weather`, `!transit`, `!news`, `!events`, `!help` alongside natural language
- **Persistent storage** — SQLite (`data/garbanzo.db`) for messages, moderation logs, daily stats
- **Strike tracking** — per-user strikes from moderation, soft-mute at 3+ strikes (30 min)

### Phase 2 milestone — 2026-02-13

### Added — Phase 2: Core Features
- **Weather** — current conditions + 5-day forecast via Google Weather API, Boston default + geocoding
- **MBTA Transit** — alerts, predictions, schedules with station/route aliases
- **Content moderation** — two-layer: regex patterns + OpenAI Moderation API, alerts to owner DM
- **New member welcome** — per-group tailored welcome on `group-participants.update`
- **News search** — top headlines and topic search via NewsAPI
- **Introduction responses** — AI-powered personal welcomes in Introductions group, 14-day catch-up
- **Emoji reactions** — reacts with bean emoji to short acknowledgments instead of full AI response
- **Event detection** — passive in Events group, composes weather + transit + Claude summary

### Phase 1 milestone — 2026-02-13

### Added — Phase 1: Minimum Viable Bot
- Baileys v6 WhatsApp connection with multi-device auth
- Claude AI responses via Anthropic/OpenRouter (Sonnet 4)
- @mention detection in 8 WhatsApp groups
- systemd user service for production deployment
- QR code scanning for initial auth
- Auth state persistence across restarts
- Auto-reconnect on disconnect
- Pino structured logging
