# Scaling Garbanzo

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

- introduce a DB backend interface in `src/utils/db-*`
- migrate state to Postgres with a one-time migration tool
- maintain a local fallback mode for hobby/community deployments
