# Garbanzo Product Roadmap
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


This roadmap describes the next major product milestones for Garbanzo.

It focuses on user-facing outcomes, platform trust, and sustainable operations.

## Direction

Garbanzo is an AI chat operations platform for communities and small teams.

Priority order:

1. Improve reliability and operator confidence.
2. Improve member-facing workflows and usability.
3. Expand platform support through stable adapter boundaries.
4. Add advanced governance features where demand is proven.

## Current Focus (Near Term)

### 1) Product Clarity and Adoption

- Improve onboarding clarity in README and docs.
- Keep setup paths simple for Docker-first deployments.
- Make supported-vs-experimental platform posture explicit.

### 2) Operational Reliability

- Keep health/readiness and backup verification as first-class release gates.
- Tighten release and rollback runbooks.
- Keep default deployments version-pinned and reproducible.

### 3) Member Experience

- Continue improving community workflows (summaries, recommendations, event planning, moderation alerts).
- Keep chat updates concise and useful.
- Avoid noisy automations that reduce trust.

## Planned Milestones

### Platform Bridging - Delivered (v3)

- Tier 1: shared memory across platform instances, explicit and reversible
  (`!memory share`/`unshare`), with clear source and scope boundaries. Done.
- Tier 2: bridge-map message relay between configured channels and groups,
  over `http` or `amqp` (RabbitMQ) transports. WhatsApp-bound relays flow
  through the existing outbound-safety layer by default. Done.
- Setup guide: [docs/BRIDGING.md](BRIDGING.md).
- Tier 3 (single-process multi-runtime) and media re-upload (media relays as
  typed placeholders today, e.g. "[voice note]") remain deferred.

### RAG Federation - Delivered (2026-07-07)

- Read-only source registry in `config/rag-sources.json`, with per-source
  Qdrant collection, embedding settings, chat allowlists, and hit/score caps.
  Done.
- Prompt-time federated source hits stay separate from shared memory and never
  write to source collections. Done.
- Setup guide: [docs/RAG_FEDERATION.md](RAG_FEDERATION.md).

### Helm Chart - Delivered (2026-07-07)

- Kubernetes chart for homelab and cluster operators lives in `deploy/helm/`.
  Done.
- Docker Compose remains the default install path for most self-hosted
  deployments.

### 3.x candidates

- Cross-language bridge translation: reuse the existing language detection
  path for relayed messages.
- Voice-note transcription relay: reuse the Whisper path and replace the
  current "[voice note]" bridge placeholder with transcript text when
  available.
- Media re-upload for bridged attachments.
- Digest headers with chat display names, backed by a new envelope field.
- Opt-in memory ingestion of bridged content, with clear source attribution
  and per-route controls.
- Tier 3 single-process multi-runtime remains deferred until the multi-process
  model shows a real operational limit.

## Platform expansion (researched 2026-07-06)

Candidates for the next platform adapter, ranked:

1. **Telegram** — lowest engineering risk of any candidate: an official free
   Bot API and a mature TypeScript-native client library, with no account-ban
   risk (unlike WhatsApp/Baileys).
2. **Matrix** — best fit for a self-hosted, privacy-minded community
   audience, backed by a real demand signal (a large spike in Matrix interest
   during a 2026 Discord trust incident), with a healthy TypeScript-native
   bot SDK.
3. **Mattermost** — a clean official bot-account API and a genuinely free
   self-hosted core (bot accounts don't consume paid seats), with strong
   audience overlap as another self-hosted OSS chat tool.

Also planned:

- **Slack completion** — finish the existing Slack scaffold into a
  production runtime, as cleanup rather than new priority. The SDK is mature
  and fits Garbanzo's self-hosted model, but Slack's free-tier message
  history cap makes it a weaker primary home for a memory-carrying bot than
  the top three above.
- **XMPP (community tier)** — technically shovel-ready (mature client
  libraries, native group-chat support, no adverse bot policy found), but a
  small enough addressable audience that it fits better as a
  community-contributed adapter than a roadmap item.

**Explicit non-goals, with reasons:**

- **Signal** — no official bot API, and unofficial clients took on
  unhedgeable ban risk after a March 2026 mass-deregistration of outdated
  unofficial clients. Unlike WhatsApp's behavior-based anti-ban posture, this
  is a protocol-versioning cliff that can't be managed with rate limits or
  warm-up ramps.
- **Microsoft Teams** — the bot SDK the existing stub targets
  (`botbuilder-js`) was archived in January 2026. Building this out would
  mean a full rewrite against Microsoft's replacement SDK.
- **IRC** — Libera.Chat, the largest IRC network, adopted a May 2026 policy
  restricting autonomous LLM-driven bots, undercutting IRC's appeal as an
  easy low-effort target.
- **Social media (X/Twitter, Bluesky)** — mostly a modality mismatch for a
  group-chat bot. X's group messaging API exists but is approval-gated and
  metered per action. Bluesky's group-chat feature is new enough that
  third-party bot access to it is unconfirmed; worth re-checking later.

## Milestone A: Narrative and Docs Alignment

- Align README, website, and docs around a single product story.
- Clarify who Garbanzo is for and what it does not try to be.
- Keep public docs reusable and free of internal-only business playbooks.

Done when:

- New users can understand value, deployment path, and support expectations quickly.

## Milestone B: Paid-Readiness Baseline

- Improve admin controls and usage visibility.
- Keep release communication policy member-safe by default.
- Ensure support and deployment workflows are documented and repeatable.

Done when:

- Multiple production users can operate with low manual intervention.

## Milestone C: Platform Expansion Quality

- Continue adapter architecture hardening.
- Improve Slack/Discord/Teams adapter parity where practical.
- Keep platform-specific behavior explicit and testable.

Done when:

- Cross-platform behavior is predictable for common command and routing paths.

## Milestone D: Advanced Governance (Demand-Gated)

- Expand governance controls only when real customer demand justifies it.
- Keep open-core usability strong while adding optional operational depth.

Done when:

- Governance additions have clear user demand and adoption evidence.

## Release and Deployment Principles

- Every release should be deployable and reversible quickly.
- Member-facing release notes should only include changes relevant to members.
- Internal/operator changes should remain internal unless a member-facing impact exists.
- Website changes should be deployed and verified as part of release completion.

## What We Avoid

- Shipping speculative features with no user pull.
- Over-expanding platform claims beyond tested capability.
- Sending release chatter to groups for internal-only engineering changes.
- Overcomplicated setup paths that increase maintenance burden.

## How to Track Progress

Primary indicators:

- Stable deploy and rollback execution.
- Active usage of member-facing features.
- Low operational incident volume.
- Clear onboarding and documentation feedback.

For release mechanics and command specifics, see `docs/RELEASES.md`.
