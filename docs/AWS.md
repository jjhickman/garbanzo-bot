# AWS Deployment Notes

This document describes pragmatic ways to run Garbanzo on AWS using your own AWS account.

Garbanzo's WhatsApp transport is Baileys (WhatsApp Web multi-device). That has two operational implications on AWS:

- First boot requires scanning a QR code (you need a way to see logs)
- Auth state must be persistent (the `baileys_auth/` volume)

Garbanzo also uses SQLite for local state by default. For the simplest, most reliable AWS deployment, prefer a single VM with local disk (EBS) rather than a network filesystem.

## Scaling Note (SQLite + Baileys)

Today, Garbanzo is designed as a single-instance deployment:

- Baileys session state is not designed for active-active multi-replica operation.
- SQLite is a single-node database and does not support horizontal scaling the way Postgres does.

On AWS, the practical scaling strategy is vertical (bigger instance) plus good backups.

If you later want true multi-instance scalability, the likely path is:

- add official messaging platform adapters (Slack/Teams/WhatsApp Business Platform)
- move durable state from SQLite to Postgres (RDS)
- use queues (SQS) for async work where ordering is not critical

## Recommended: EC2 + Docker Compose (Simple + Reliable)

If you like infrastructure-as-code, see `infra/cdk/` for an AWS CDK app that provisions an EC2 instance and bootstraps a pinned Docker Compose deployment.

This is the easiest path that keeps SQLite on a local filesystem and preserves the same Docker Compose runtime as your NAS deployment.

### 1) Create an instance

- Instance type: `t3a.small` (or larger if you enable heavy multimedia)
- Storage: gp3 EBS (20-50GB)
- OS: Ubuntu 24.04 LTS

Security Group (inbound):

- Allow SSH (`22/tcp`) from your IP only
- Optional: allow `/health` port (`3001/tcp`) only from your Uptime Kuma host IP
- Do not expose WhatsApp/Baileys ports publicly (Garbanzo initiates outbound connections)

### 2) Install Docker

On the instance:

- Install Docker Engine + Compose plugin (Ubuntu official docs)
- Add your user to the `docker` group

### 3) Deploy Garbanzo

```bash
git clone https://github.com/jjhickman/garbanzo-bot.git
cd garbanzo-bot
cp .env.example .env
# edit .env and config/groups.json

APP_VERSION=0.1.1 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.1 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

docker compose logs -f garbanzo
```

Scan the QR code from the logs on first run.

### 4) Monitoring

- Use `GET /health` for informational status
- Use `GET /health/ready` for alerting (503 when disconnected/stale)

If you publish port `3001` publicly/within a VPC, restrict it to trusted monitors.

## Option: ECS Fargate + EFS (More Portable, More Moving Parts)

If you want this managed path in the future, we recommend doing EC2 first to prove stability, then migrating once you know your steady-state CPU/memory and data retention needs.

You can run Garbanzo as an ECS task, but you must solve persistence:

- Baileys auth requires persistent storage (EFS works well)
- SQLite prefers local disk; SQLite on EFS can work but has more risk (latency/locking). For production at scale, consider migrating state to Postgres.

If you still want Fargate:

- Use EFS for `/app/baileys_auth` and `/app/data`
- Send logs to CloudWatch
- Use ECS Exec for debugging
- Ensure the task has outbound internet access (NAT gateway if in private subnets)

## Secrets

For AWS deployments, prefer one of:

- AWS Systems Manager Parameter Store (Standard)
- AWS Secrets Manager

Inject secrets into the container environment at runtime (avoid writing provider keys to disk where possible).

## Portability Notes

Garbanzo is intentionally designed to be deployable as:

- a single Docker Compose service
- a single container on managed runtimes

If you want a "business-grade" AWS posture, the big architectural fork is the transport:

- Slack/Teams can be first-class on AWS using official APIs
- WhatsApp via Baileys remains best-effort community-grade; WhatsApp Business Platform requires a separate adapter and different onboarding
