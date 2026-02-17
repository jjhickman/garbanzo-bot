# Scaling Garbanzo
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Garbanzo is designed first for stable self-hosting and community operations.

Today, the default architecture is intentionally single-instance:

- WhatsApp transport uses Baileys (WhatsApp Web multi-device)
- Durable state is SQLite (`data/garbanzo.db`)

This combination is reliable and easy to run, but it is not "horizontal scale" by default.

## What Scales Today

Prometheus/Grafana-style monitoring can be layered on via `GET /metrics` (optional). This gives you time-series visibility without changing the deployment model.

- Vertical scale (bigger CPU/RAM) on one host
- Higher availability through operational hygiene:
  - health endpoints (`/health`, `/health/ready`)
  - backups + integrity checks
  - well-scoped features and rate limiting

## What Does Not Scale Today

- Active-active replicas on WhatsApp/Baileys
- Multi-instance writers to SQLite

## AWS Guidance

For AWS, the recommended deployment is EC2 + Docker Compose (see `docs/AWS.md` and `infra/cdk/`).

- Keep state on local EBS
- Use CloudWatch Logs for visibility
- Use SSM for access (no inbound ports)

## Path to True Multi-Instance Scale

If you want to support multiple instances reliably, the likely roadmap is:

1) Messaging platforms with official APIs (Slack/Teams/WhatsApp Business Platform)
2) Move durable state from SQLite to Postgres (RDS)
3) Introduce queues (SQS) for async workloads where ordering is not critical
4) Add stateless worker services for expensive/non-interactive workloads

## Database Strategy

SQLite is a deliberate choice for early-stage reliability.

When Postgres becomes necessary:

- keep a backend interface in `src/utils/db-*` (sqlite + postgres backends)
- initialize Postgres schema with `npm run db:postgres:init`
- migrate state with `npm run db:sqlite:migrate:postgres`
- verify migrated row counts with `npm run db:sqlite:verify:postgres`
- validate backend behavior with `npm run test:postgres`
- follow the migration checklist in `docs/POSTGRES_MIGRATION_RUNBOOK.md`
- keep sqlite local fallback mode for single-machine/community deployments

Current status:

- backend contract abstraction is in place
- Postgres schema + migration scripts are available
- runtime Postgres query backend is implemented and selectable via `DB_DIALECT=postgres`
- CI runs a dedicated Postgres backend test job (`tests/postgres-backend.test.ts`)
- CDK includes a Phase 2 ECS+RDS stack for Slack/Discord official runtimes (`infra/cdk/lib/garbanzo-ecs-stack.ts`)
