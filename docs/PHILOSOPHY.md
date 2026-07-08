# Philosophy

## Lessons From a Prior Tool-Heavy Assistant Stack (Trust & Maturity)

Before Garbanzo, we ran a more ambitious multi-service assistant setup (more services, more automation, and a bigger tool surface). That experience taught a key lesson:

Reliability comes from fewer moving parts and explicit guardrails, not from more integrations.

What we kept (good ideas that translate well to AI community operations):

- A bias toward useful "skills" (weather/transit/events/summaries) rather than generic chat
- Tooling that makes the bot operationally observable (health endpoints, backups, logs)
- Cost discipline: explicit routing and fallbacks across configured cloud providers plus any local OpenAI API-compatible provider

What we intentionally changed in Garbanzo (why it's safer and easier to run for group deployments):

- **Smaller operational surface area:** one shared core pipeline with platform adapters instead of channel-specific reimplementations
- **Curated features, not a marketplace:** no automatic install/run of third-party skills; features live in-repo and ship via release tags
- **Group safety defaults:** mention gating + per-group feature allowlists
- **Ops-first health semantics:** `GET /health` for visibility and `GET /health/ready` for alerting on connection loss; idle chat periods are informational
- **Local-first, inspectable state:** SQLite + explicit backups; health reports backup integrity
- **Security guardrails in CI:** secrets scan + typecheck + lint + tests (`npm run check`)

## What Makes Garbanzo Different

Garbanzo is built as an AI operations layer, not just a transport wrapper.

- **Compared to messaging APIs/SDKs:** APIs handle message transport; Garbanzo ships end-to-end AI workflows and operational controls.
- **Compared to raw bot libraries:** Garbanzo includes routing, moderation, retries, health checks, setup wizard flows, and release tooling.
- **Compared to single-provider bots:** Garbanzo supports provider orchestration across OpenAI, Anthropic, Gemini, Bedrock, OpenRouter, plus any local OpenAI API-compatible provider.
- **Compared to generic chat assistants:** Garbanzo is tuned for real group operations (events, summaries, moderation, memory, owner controls).

Bridging is built for operators who already have communities split across places. Separate instances keep their own platform runtime, env file, volumes, and local memory, while `config/bridge-map.json` relays only the communities the operator maps.

The privacy posture stays operator-controlled and explicit. SQLite remains the source of record, Qdrant stores vectors under operator control, shared memory requires an owner command, and federated RAG sources are read-only.

## Who This Is For

- Operators who need AI-assisted coordination in busy communities
- Small teams that want reliable AI automations without managed-platform lock-in
- Builders who need an extensible AI bot runtime with real operational guardrails
