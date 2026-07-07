# Scaling Garbanzo
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

Garbanzo now ships a multi-instance model for operators who want separate Discord and WhatsApp processes, multiple deployments of the same platform, or bridged communities. Each process still owns one platform runtime.

## Shipped Multi-Instance Model

The default compose profiles are `discord`, `whatsapp`, `monitoring`, and optional `broker`.

Use `INSTANCE_ID` to give each deployment a stable identity. It is used by bridge routes, shared-fact ids, metrics, and the derived local Qdrant collection name. If `INSTANCE_ID` is set and `QDRANT_COLLECTION` is left unset, local facts land in `garbanzo_memory_<INSTANCE_ID>`.

For multiple instances, keep these isolated per instance:

- platform env file and `INSTANCE_ID`
- Docker service name
- health port
- data/auth volumes
- local Qdrant collection, either derived from `INSTANCE_ID` or set explicitly

Message relays use the bridge subsystem. `config/bridge-map.json` maps selected Discord channels and WhatsApp groups between instances. HTTP transport is the default for two instances on the same compose network. AMQP transport uses the `broker` profile for larger topologies or longer peer outages.

Same-account WhatsApp deployments use WhatsApp linked devices. Create a second compose service with its own auth volume, env file, `INSTANCE_ID`, and port, then link that service as another companion device. Do not share one Baileys auth volume between services.

## What Scales Today

- Multiple platform instances on one host through compose profiles and copied services.
- Cross-instance chat relay through the bridge outbox and HTTP or AMQP transport.
- Shared memory through explicit `!memory share <id>` into the shared Qdrant collection.
- Read-only RAG federation from configured Qdrant sources in `config/rag-sources.json`.
- Vertical scaling on one host by increasing CPU/RAM, moving heavier services off-host, or switching relational state to Postgres.
- Operational visibility through `/health`, `/health/ready`, `/metrics`, Prometheus, Grafana, and backups.

## Per-Instance Limits

One process is still one platform runtime. Do not run active-active replicas of the same Discord bot token or the same Baileys auth state. SQLite remains a single-node database per instance, so concurrent writers should stay inside one process unless you move that deployment to Postgres.

WhatsApp outbound safety is per instance and remains load-bearing. Bridged messages to WhatsApp still pass through the receiving instance's normal outbound safety path.

## Database Strategy

SQLite is the default for self-hosted deployments. It keeps the single-host path simple and easy to back up.

Use Postgres when a deployment needs managed storage, multiple service roles, or cloud operational patterns:

- initialize schema with `npm run db:postgres:init`
- migrate state with `npm run db:sqlite:migrate:postgres`
- verify row counts with `npm run db:sqlite:verify:postgres`
- validate backend behavior with `npm run test:postgres`
- follow [POSTGRES_MIGRATION_RUNBOOK.md](POSTGRES_MIGRATION_RUNBOOK.md)

Current status:

- backend abstraction is in place
- Postgres schema and migration scripts are available
- runtime Postgres backend is selectable with `DB_DIALECT=postgres`
- CI covers the Postgres backend contract

## Kubernetes Threshold

Docker Compose is still the default install path. Move to k3s or another Kubernetes setup when the operational need is real:

- multiple nodes or separate host pools
- several Garbanzo services with health-gated rollouts
- standard secret, volume, ingress, and monitoring workflows
- a need to manage Qdrant, app pods, and future workers with the same control plane

The Helm chart in `deploy/helm/` supports that path. For one host or a small number of instances, Compose is simpler to debug and recover.

## AWS Guidance

For a simple AWS deployment, EC2 plus Docker Compose remains the practical starting point. Keep state on EBS, use SSM for access, and expose health only to trusted monitors.

For managed cloud runtime work, the CDK stack under `infra/cdk/` targets official platform runtimes and Postgres-backed deployments.
