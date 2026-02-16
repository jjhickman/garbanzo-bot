# AWS Deployment Notes

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

APP_VERSION=0.1.6 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.6 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

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

## Revenue Website on AWS (S3 + CloudFront)

To stand up a public support/marketing page quickly, use the website stack in `infra/cdk`.

1. Ensure AWS CLI auth is active (`aws sts get-caller-identity`).
2. Deploy the site stack (with optional custom domain):

```bash
cd infra/cdk
npm install
cdk deploy GarbanzoSiteStack \
  -c deployEc2=false \
  -c deploySite=true \
  -c siteDomainName=garbanzobot.com \
  -c siteHostedZoneId=Z065585312QAJF1P6J0UL
```

3. Copy the `WebsiteUrl` output and set it as repo homepage:

```bash
gh repo edit --homepage "https://<website-url>"
```

4. (Recommended) configure automatic website deploys from GitHub Actions:

- Add `AWS_ROLE_TO_ASSUME` (secret or repo variable) with OIDC trust for this repo
- Optional repo variables:
  - `AWS_REGION` (default `us-east-1`)
  - `SITE_DOMAIN_NAME` (e.g., `garbanzobot.com`)
  - `SITE_HOSTED_ZONE_ID` (Route53 zone id)
  - `SITE_PRICE_CLASS` (`100`, `200`, `all`)
- Workflow: `.github/workflows/deploy-support-site.yml`

5. Update your support links:

- Set `PATREON_URL` in your runtime `.env` (e.g., `https://www.patreon.com/c/garbanzobot`)
- Keep Patreon handle in `.github/FUNDING.yml` in sync
- Run owner command `!support broadcast` after links are updated

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
