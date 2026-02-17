# AWS Deployment Notes
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


This document describes pragmatic ways to run Garbanzo on AWS using your own AWS account.

Garbanzo's WhatsApp transport is Baileys (WhatsApp Web multi-device). That has two operational implications on AWS:

- First boot requires scanning a QR code (you need a way to see logs)
- Auth state must be persistent (the `baileys_auth/` volume)

Garbanzo also uses SQLite for local state by default. For the simplest, most reliable AWS deployment, prefer a single VM with local disk (EBS) rather than a network filesystem.

## Scaling Note (SQLite + Baileys)

See also: `docs/SCALING.md`

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

- Recommended: no inbound ports; use SSM Session Manager for access
- Optional: allow `/health` port (`3001/tcp`) only from a trusted monitor (and only if the instance is reachable)
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

APP_VERSION=0.1.8 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.8 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

docker compose logs -f garbanzo
```

Scan the QR code from the logs on first run.

### 4) Monitoring

- Use `GET /health` for informational status
- Use `GET /health/ready` for alerting (503 when disconnected/stale)

Hardened option (recommended): do not open port 3001 at all. Use SSM port forwarding when needed:

```bash
aws ssm start-session \
  --target i-xxxxxxxxxxxxxxxxx \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3001"],"localPortNumber":["3001"]}'

curl http://127.0.0.1:3001/health
```

If you publish port `3001` publicly/within a VPC, restrict it to trusted monitors.

## Option: ECS Fargate + RDS (Phase 2 target)

For Slack/Discord official runtimes, ECS + RDS is now the preferred managed AWS path.

The CDK stack (`infra/cdk/lib/garbanzo-ecs-stack.ts`) provisions:

- ALB ingress with path routing (`/slack/events*`, `/discord/interactions*`)
- Fargate services (one per platform runtime)
- RDS Postgres in isolated subnets
- Secrets Manager wiring for platform tokens and Postgres credentials
- Bedrock IAM invoke permissions on task roles

Deploy docs and context flags are in `infra/cdk/README.md`.
Run `npm run aws:ecs:preflight` from repo root before deploy to validate AWS account/zone/cert/secret readiness.
Run `npm run aws:ecs:audit` to synth-audit ECS IAM/task-definition wiring before deploy.
Run `npx vitest run tests/dockerfile-runtime-assets.test.ts` to verify Postgres schema SQL is bundled into runtime images.

Notes:

- This stack targets Slack/Discord runtimes, not Baileys WhatsApp.
- RDS is the durable store (`DB_DIALECT=postgres`) for multi-service operation.
- Use Route53 + ACM for `bot.garbanzobot.com` HTTPS termination on ALB.
- Optional: enable `deployDemo=true` and `demoDomainName=demo.garbanzobot.com` for a public Slack-demo runtime that showcases features without local install.
- Demo runtime abuse controls include Turnstile challenge keys from `demoSecretArn`, demo-host scoped AWS WAF (rate + managed common/bot rules), CloudWatch alarms, and capped ECS autoscaling.
- For deterministic synth/deploy in CI, pass both `hostedZoneName` and `hostedZoneId` to avoid Route53 lookup context resolution.

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
