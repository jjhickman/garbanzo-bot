# Changelog

All notable changes to Garbanzo are documented here.

## [Unreleased]

### Changed

- Setup wizard now supports Slack demo mode configuration (`--platform=slack --slack-demo=true`) and writes `SLACK_DEMO*` env settings.
- Setup completion messaging now explicitly clarifies platform status (WhatsApp support, Slack demo local-only, Discord/Teams pending).
- Added script-level coverage for Slack setup dry-run behavior to keep setup output deterministic and regression-safe.
- Added `npm run release:checklist` helper to create and assign release checklist issues using the protected-`main` workflow.
- Added a rollback playbook to `docs/RELEASES.md` and linked it from the release checklist template.
- Added `npm run release:deploy:verify` helper to deploy a target tag, verify health/readiness, and optionally auto-rollback.
- `release:deploy:verify` now accepts both `--flag value` and `--flag=value` forms for safer CLI usage in scripts.
- Added an AWS CDK support-site stack (`GarbanzoSiteStack`) to publish `website/` to S3 + CloudFront.
- Added local Discord demo runtime scaffolding (`DISCORD_DEMO`) with HTTP simulation and parity tests, mirroring the Slack demo pattern.
- Added custom-domain support to the AWS support-site stack (`siteDomainName` + `siteHostedZoneId`) and wired Patreon support links into site/repo funding metadata.
- Added GitHub Actions support-site deploy workflow (`deploy-support-site.yml`) for website/CDK site changes.
- Added sponsorship strategy documentation (`docs/SUPPORT.md`) including Patreon tier guidance aligned with licensing boundaries.
- Updated website theme colors to match the Garbanzo logo palette and simplified support docs to project-reusable guidance only.
- Hardened GitHub Actions AWS deploy role to least-privilege assumptions for support-site automation.

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
