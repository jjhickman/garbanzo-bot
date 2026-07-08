# Garbanzo Architecture
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

Garbanzo is a Discord-first, multi-platform community bot. One process runs one platform runtime, selected by `MESSAGING_PLATFORM`, while the shared core handles message normalization, safety, routing, AI calls, memory, and observability.

## Runtime Shape

- **Entry and lifecycle:** startup, config validation, health server, maintenance jobs, bridge lifecycle, and platform runtime selection.
- **Platform adapters:** Discord Gateway is the default production runtime. WhatsApp, Discord, Telegram, and Matrix are fully supported. Slack is an experimental scaffold.
- **Core pipeline:** platform-neutral inbound processing, group command routing, owner DM routing, response generation, and outbound messenger contracts.
- **AI layer:** provider failover through `AI_PROVIDER_ORDER`, optional local OpenAI API-compatible AI provider for simple queries, shared tool definitions, and provider-specific request builders.
- **Persistence:** SQLite is the default source of record. Postgres support exists behind the database backend layer for managed deployments.
- **Vector memory:** Qdrant is the single vector store for semantic memory and shared facts. `VECTOR_STORE=none` falls back to keyword-only memory search.
- **Operations:** Pino logs, health/readiness endpoints, token-gated admin and metrics surfaces, Prometheus/Grafana, retries, stats, and backup metadata.

## Message Pipeline

Every platform adapter produces the same `InboundMessage` shape before the shared core takes over:

```text
Platform event
  -> platform adapter normalizes to InboundMessage
  -> processInboundMessage
       -> transport guards
       -> sanitize text
       -> moderation checks and owner escalation
       -> bridge capture hook
       -> group dispatch or owner DM dispatch
  -> processGroupMessage / owner command handlers
       -> bang command, feature route, or AI route
  -> PlatformMessenger sends the reply through the active adapter
```

The bridge capture hook runs after sanitization and moderation and before group dispatch. It is fire-and-forget, so a bridge outage does not block the member reply path.

## Platform Adapters

Discord uses the official Gateway through the Discord runtime. Channel and role settings live in `config/discord-channels.json`, with `DISCORD_CHANNELS_CONFIG_PATH` available for overrides. The default Docker service is `discord`, and its health server listens on port `3002`.

WhatsApp uses Baileys with persistent auth state, browser or terminal login, and outbound anti-ban controls. Group bindings live in `config/groups.json`. The default Docker service is `whatsapp`, and its health server listens on port `3001`.

Telegram uses grammY over long polling (no inbound webhook config needed). Chat bindings live in `config/telegram-chats.json`, with `TELEGRAM_CHATS_CONFIG_PATH` available for overrides. The default Docker service is `telegram`, and its health server listens on port `3005`. See [docs/PLATFORMS.md](PLATFORMS.md) for the BotFather setup walkthrough and the privacy-mode recommendation.

Matrix uses `matrix-bot-sdk` over `/sync` long polling, with the sync token persisted to `data/matrix-sync.json` so a restart resumes instead of running a fresh initial sync. Room bindings live in `config/matrix-rooms.json`, keyed by room ID, with `MATRIX_ROOMS_CONFIG_PATH` available for overrides. The default Docker service is `matrix`, and its health server listens on port `3004`. Encrypted rooms are not supported. See [docs/PLATFORMS.md](PLATFORMS.md) for the bot-account setup walkthrough and the unencrypted-room requirement.

All four services use layered env files: `.env` for shared provider/runtime settings, `.env.discord` for Discord instance settings, `.env.whatsapp` for WhatsApp instance settings, `.env.telegram` for Telegram instance settings, and `.env.matrix` for Matrix instance settings. `COMPOSE_PROFILES` selects `discord`, `whatsapp`, `telegram`, `matrix`, `monitoring`, and optional `broker`.

## Bridge Subsystem

The bridge subsystem relays configured chats between instances. It is default-off and configured with `BRIDGE_ENABLED`, `INSTANCE_ID`, `BRIDGE_TRANSPORT`, and `config/bridge-map.json`.

Flow:

```text
capture hook
  -> build bridge envelope
  -> durable per-instance outbox
  -> transport: HTTP or AMQP
  -> receiver /bridge/inbound
  -> idempotency insert
  -> direct messenger delivery or summary buffer
```

HTTP transport sends directly to peer instance health ports and authenticates `/bridge/inbound` with the shared `MONITORING_TOKEN` bearer token. AMQP transport uses RabbitMQ from the `broker` compose profile for three-or-more instance topologies or longer peer outages.

Receivers insert the bridge idempotency key before delivery and delete it if delivery throws, so sender retries are not silently dropped after a failed attempt. Relays are delivered through direct messenger sends on the receiving instance rather than synthetic inbound messages. When a WhatsApp send is held by outbound safety, the bridge treats it as backpressure and keeps or moves the content through the summary buffer instead of bypassing safety.

## Configuration Model

Config is split by concern under `src/utils/config/` and validated with Zod at startup. The setup wizard writes layered env files, while runtime JSON config files stay in `config/`:

- `config/discord-channels.json` for Discord channel, role, and owner-channel settings.
- `config/groups.json` for WhatsApp group names, mention patterns, per-group personas, and enabled features.
- `config/bridge-map.json` for cross-instance route maps.
- `config/rag-sources.json` for read-only RAG federation sources.

`INSTANCE_ID` identifies a deployment for bridge routes, shared-fact ids, and metrics. When `INSTANCE_ID` is set and `QDRANT_COLLECTION` is left unset, the local vector collection defaults to `garbanzo_memory_<INSTANCE_ID>`.

## Memory and Retrieval

SQLite remains the source of record for messages, profiles, moderation records, stats, configured facts, bridge outbox rows, and bridge buffers. Qdrant stores vector embeddings for local semantic memory. Deterministic embeddings are for tests only.

Shared memory is explicit. A fact enters the shared Qdrant collection only when the owner runs `!memory share <id>`. Shared fact ids are namespaced by `INSTANCE_ID` or the platform fallback, and only the origin instance can unshare them.

RAG federation is separate from shared memory. When `RAG_FEDERATION_ENABLED=true`, the instance reads from sources listed in `config/rag-sources.json` and adds bounded, read-only source hits to the prompt. Garbanzo does not write facts, messages, summaries, or embeddings to federated sources.

## AI and Tools

The AI layer classifies queries, tries local Ollama when appropriate, then follows the configured cloud provider order. Tool definitions cover weather, transit, venues, news, books, web search, memory, and band features. The system prompt tells models to prefer tools for factual or live information rather than relying on training data.

Provider callers share payload shaping and response parsing where possible. Usage and tool-call counters feed the stats and monitoring surfaces.

## Monitoring and Operations

The health server exposes:

- `GET /health` for process and diagnostic status.
- `GET /health/ready` for alerting on disconnected or stale runtimes.
- `GET /metrics` when metrics are enabled and authenticated.
- `/admin` behind the same monitoring token.

Docker defaults are platform-specific: Discord binds `127.0.0.1:3002:3002`, while WhatsApp binds `0.0.0.0:3001:3001`. `MONITORING_TOKEN` gates `/metrics`, `/admin`, Prometheus scrapes, and HTTP bridge inbound delivery.

## Deployment Shapes

The default deployment is Docker Compose with profiles:

- `discord` for the Discord Gateway runtime plus Qdrant.
- `whatsapp` for the Baileys runtime plus Qdrant.
- `monitoring` for Prometheus and Grafana.
- `broker` for RabbitMQ when AMQP bridge transport is needed.

Single-host deployments use SQLite and named Docker volumes. Multi-instance deployments set distinct `INSTANCE_ID` values, use separate platform env files and volumes, and bridge selected chats through HTTP or AMQP. Same-account WhatsApp companion deployments are modeled as separate compose services with separate linked-device auth state.

For Kubernetes operators, `deploy/helm/` contains the Helm chart. Docker Compose remains the default install path for self-hosted community deployments.
