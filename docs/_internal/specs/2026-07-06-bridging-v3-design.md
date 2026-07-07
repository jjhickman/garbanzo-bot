# Cross-Platform Bridging (v3) — Design Spec

**Date:** 2026-07-06
**Status:** Approved direction (owner accepted the outbox + HTTP recommendation; build pending owner go)
**Branch:** `feat/bridging-v3`
**Version:** 3.0.0 (headline feature release; all new behavior is flag-gated and DEFAULT OFF, so existing deployments upgrade inert)

## Summary

Two tiers, per the owner-approved recommendation:

- **Tier 1 — shared brain:** the discord and whatsapp instances share owner-curated memory through a dedicated shared Qdrant collection, explicitly and reversibly (`!memory share <id>`). Retrieval-side merge only; the relational DBs stay per-instance.
- **Tier 2 — message bridging:** chat routes mapped in `config/bridge-map.json` relay text across instances with attribution ("Ana (WhatsApp): …"), through a durable per-instance outbox and a pluggable `BridgeTransport`: **HTTP** (two instances, zero extra containers) or **AMQP/RabbitMQ** (owner-directed, 2026-07-06: N instances — including multiple instances of the same platform — publish/consume durable queues on a broker; the owner will run this). WhatsApp-bound relays ride the anti-ban outbound-safety layer with a summary-buffer fallback; Discord-bound sends gain the 429 handling the adapter currently lacks.

**Instance identity (owner directive):** deployments are identified by `INSTANCE_ID` (new config key, defaults to `MESSAGING_PLATFORM` so existing deployments need no change). Bridge routes, shared-memory refIds, outbox rows, and metrics labels all key on instance id, never bare platform — so `discord-band` and `discord-community` can coexist. Attribution still displays the *platform* name (readers care that Ana wrote on WhatsApp). Running a second same-platform instance is a documented compose pattern (copy the service block: new service name, `INSTANCE_ID`, env file, volume, port), not a wizard flow.

**Explicitly deferred:** Tier 3 (single-process multi-runtime), media re-upload (media relays as typed placeholders, e.g. "[voice note]"), auto-shared session/message memory, **Slack runtime productionization** (today it is a scaffold; the bridge is platform-generic via `PlatformMessenger`/`InboundMessage`, so a matured Slack instance bridges with zero bridge changes — maturing Slack is its own project).

## Grounding (exploration findings that shape the design)

1. Vector payloads already carry `kind` ('message'|'session'|'fact') and `scope` ('chat'|'global') but **no instance/origin field**; a store binds ONE collection at construction. → Tier 1 uses a **second store instance bound to a dedicated shared collection** (no backfill, no schema change to live collections, respects the never-mix-vector-spaces invariant).
2. Curated fact ids are per-instance SQLite autoincrements mirrored to Qdrant by `refId` — **numeric refIds collide across instances**, and `!memory delete <id>` would hit the wrong row. → Shared facts use **namespaced refIds** (`<platform>:<localId>`), are **owned by the origin instance** (only it can unshare), and are **retrieval-only** on the peer. `!memory search` labels shared hits and never maps them to local numeric ids.
3. Every WhatsApp send through the platform messenger automatically routes through the anti-ban layer (protected socket proxy); over-limit sends **throw `WhatsAppOutboundHeldError` and await manual owner release** — held is backpressure, not a retryable failure. → The bridge treats held as a signal to **switch the pair into summary-buffer mode**, never blind-retries.
4. The Discord adapter sends via raw fetch and **throws on 429 with no backoff**. → New bounded 429/Retry-After handling wraps bridge sends into Discord (and is written so the adapter itself can adopt it).
5. Loop prevention comes nearly free from the existing architecture: relays are delivered as **direct messenger sends on the receiving instance** (they never re-enter `processInboundMessage`), and each platform's inbound path already drops the bot's own messages (`fromSelf` / `author.bot`). What remains is **idempotency**: receiver-side dedup keyed on `(originPlatform, originChatId, originMessageId)`.
6. `InboundMessage` has no sender display name (raw ids only) — attribution needs **new `senderName` plumbing** (WhatsApp pushName, Discord member display name).
7. No cross-platform markdown translation exists (`*bold*` vs `**bold**`) — verbatim relays need a **bounded translator** (bold/italic/strike/monospace only).
8. The health server's `/admin`-style inline authed branch (bearer `MONITORING_TOKEN`, `requestHasValidToken`, timing-safe compare, per-IP rate limit) is the template for the receiver endpoint; `extraHandler` is single-slot/sync and stays dedicated to WhatsApp login.
9. The existing retry queue is an in-memory, message-shaped singleton — **not** reused; the bridge outbox is its own SQLite-backed table with dead-lettering.
10. Both containers bind 0.0.0.0 in-container on one compose network — `http://whatsapp:3001` / `http://discord:3002` are reachable peer URLs.

## Goals

1. **Tier 1:** `!memory share <id>` / `!memory unshare <id>` (owner-only) copy/remove a curated fact to/from the shared collection (`QDRANT_SHARED_COLLECTION`, default `garbanzo_shared`) with refIds namespaced by **instance id** (`<INSTANCE_ID>:<localId>`); prompt retrieval on every instance merges shared facts, labeled with origin ("shared from remy"). Gated by `SHARED_MEMORY_ENABLED` (default false). **Privacy invariant: nothing enters the shared collection except facts the owner explicitly shares.**
2. **Tier 2:** `config/bridge-map.json` defines `instances` (`{id, platform, url?}` — url used by the http transport only) and `routes` (`{id, endpoints: [{instance, chatId}, {instance, chatId}], direction: 'both'|'<a>-to-<b>', modeToWhatsApp: 'summary'|'verbatim', modeToDiscord: 'verbatim'|'summary', relayCommands: false}`). Endpoints reference instance ids; a route between two Discord instances is legal. Defaults embody the risk posture: **into WhatsApp = summary; into anything else = verbatim; bang-commands not relayed.** Gated by `BRIDGE_ENABLED` (default false).
3. **Durability + transport:** sender-side `bridge_outbox` table (pending → sent | dead, attempt counts, backoff) and pump loop are transport-agnostic; `BRIDGE_TRANSPORT` selects delivery: `http` (POST `/bridge/inbound` to the target instance's url, bearer `MONITORING_TOKEN`) or `amqp` (publish persistent messages to a topic exchange `garbanzo.bridge`, routing key = target instance id; each instance consumes its own durable queue with manual acks; `BRIDGE_BROKER_URL`, e.g. `amqp://garbanzo:<pass>@rabbitmq:5672`; client: `amqplib`, new dependency approved by owner 2026-07-06). Receiver-side `bridge_seen` dedup gives idempotency under BOTH transports (at-least-once end to end); dead-lettered entries logged + counted in metrics. Compose gains a `rabbitmq` service under a new `broker` profile (`rabbitmq:4-management-alpine`, volume `garbanzo-bot-rabbitmq`, credentials from env, mem-limited for the Pi).
4. **Rate safety:** relays into WhatsApp go through the messenger (anti-ban automatic); `WhatsAppOutboundHeldError` flips the pair to buffering; the summary flusher (every `BRIDGE_SUMMARY_INTERVAL_MINUTES`, default 15) composes ONE WhatsApp-safe message per pair per interval ("Discord #general — last 15 min: …"). Discord sends get single-retry Retry-After handling, then fall back to outbox retry.
5. **Attribution + fidelity:** `senderName` plumbed into `InboundMessage` on both platforms; relayed text is format-translated (bounded markdown set) and prefixed `Name (Platform): `; media becomes typed placeholders; length capped (`BRIDGE_MAX_TEXT`, default 1500 chars with truncation marker).
6. **Pipeline placement:** the relay capture hook sits in `processInboundMessage` after sanitization + moderation, immediately before dispatch — fire-and-forget enqueue (never blocks or fails the AI reply path).
7. **Transport swap-ability:** `BridgeTransport` interface (`deliver(envelope, targetInstance)`, `startInbound(handler)`, `stop()`) with BOTH implementations shipped in v3: `http` (default — two-instance case, no extra containers) and `amqp` (the owner's N-instance topology). The outbox + pump sit above the interface and are identical under both.
8. **Observability:** outbox depth, delivered/deduped/dead counts, buffer sizes as Prometheus metrics; bridge status in `/health`.

## Non-goals

Tier 3 single-process; media re-upload; auto-sharing of sessions/messages/embeddings; bridging DMs (group/channel routes only); message edit/delete propagation; Slack runtime productionization; broker alternatives beyond RabbitMQ (Redis/NATS remain possible `BridgeTransport` implementations later); a wizard flow for N-instance compose (documented pattern instead); relaying bridged content into the receiving instance's AI memory (bot-authored messages are dropped by design — revisit post-v3).

## Decisions

- **Shared memory is explicit-only and facts-only** in v3. Auto-sharing conversation memory across a community chat and a band chat is a privacy hazard; the owner curates what crosses.
- **Relays deliver as direct sends, not synthetic inbounds.** Loop prevention falls out of existing self/bot drops; the receiving bot's AI does not react to relayed content (it is not @mentioned by a prefix-attributed relay in practice, and bot-authored messages are dropped from processing).
- **Outbox lives in each instance's existing SQLite** (new tables via `db-schema.ts` migration pattern) under BOTH transports — it is the crash-durability, retry, and dead-letter layer; the transport is only delivery.
- **Both transports ship** (owner directive 2026-07-06, reversing the earlier defer): `http` for the two-instance/no-extra-containers case, `amqp` for N instances — the owner intends to run RabbitMQ. Topology: topic exchange `garbanzo.bridge`, routing key = target `INSTANCE_ID`, per-instance durable queue, persistent messages, manual acks, publisher confirms; `amqplib` is the client (owner-approved dependency).
- **`MONITORING_TOKEN` authenticates instance-to-instance HTTP**; the broker path authenticates via `BRIDGE_BROKER_URL` credentials. With `BRIDGE_ENABLED=true`, a missing token (http) or broker url (amqp) is a startup config error.
- **`INSTANCE_ID` is deployment identity** (defaults to the platform name). It names bridge endpoints, shared-fact refIds, outbox/dedup rows, and metric labels. Persona names still never name infrastructure; instance ids are operator-chosen deployment names, a different category (the v2 directive stands).
- **Held ≠ failure.** On `WhatsAppOutboundHeldError` the pair enters buffered mode; the flusher retries next interval; the owner's existing `!whatsapp held/release` surface stays the manual control. Bridge never calls `sendControlText` (the safety bypass).
- **Version 3.0.0** per owner; additive/flag-gated, so migration is "set the flags and mount bridge-map.json when you want it" — a new docs/BRIDGING.md is the setup guide, and MIGRATION docs note no action needed for existing deployments.

## Testing

TDD throughout; per-task adversarial review with **mandatory outbound-safety probes on any task touching a send path** (bridge must never bypass the anti-ban proxy; held handling verified; no `sendControlText`). Compose tests updated for the bridge-map mounts and the new `broker` profile/volume (volume arrays are byte-exact assertions; the six v2 volume names stay untouched). Health endpoint tests follow the existing auth-test patterns (bearer + rate-limit + timing-safe). Transport contract tests run the SAME suite against both `BridgeTransport` implementations (http via a local test server; amqp via a mocked `amqplib` channel — no live broker in CI), covering delivery, redelivery/dedup, ack-on-success only, and connection-loss recovery. End-to-end relay tests drive both directions through injected messenger fakes, including held→buffer→flush and 429→retry→outbox paths, plus a three-instance route table exercising instance-id (not platform) addressing. Prompt-eval set re-run if persona/tools text changes (shared-fact labeling touches prompt injection).

## Docs impact

New docs/BRIDGING.md (setup for both transports incl. RabbitMQ profile, bridge-map reference, the N-instance/same-platform compose pattern, risk posture); README highlight + feature section; docs/CONFIGURATION.md (new keys: `INSTANCE_ID`, `BRIDGE_*`, `SHARED_MEMORY_ENABLED`, `QDRANT_SHARED_COLLECTION`); config/bridge-map.example.json; AGENTS.md Decisions Log (bridging model, instance identity, shared-memory privacy invariant, dual-transport decision); CHANGELOG 3.0.0 section; docs/ROADMAP.md (mark v3 delivered; Tier 3/media/Slack-productionization as candidates).
