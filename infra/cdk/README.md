# Garbanzo AWS CDK

This CDK app provisions a simple EC2-based deployment suitable for running Garbanzo with SQLite + persistent Baileys auth.

## Why EC2?

- SQLite works best on local disk (EBS)
- Baileys auth requires persistence
- Fargate + EFS is possible but adds complexity and can be harder to debug

## Prereqs

- AWS CLI configured for your account
- Node.js 20+

## Install

```bash
cd infra/cdk
npm install
```

## Create SSM parameters

Store your `.env` as a SecureString:

```bash
aws ssm put-parameter \
  --name /garbanzo/prod/env \
  --type SecureString \
  --value "$(cat ../../.env)" \
  --overwrite
```

Store `config/groups.json` as a String:

```bash
aws ssm put-parameter \
  --name /garbanzo/prod/groups_json \
  --type String \
  --value "$(cat ../../config/groups.json)" \
  --overwrite
```

## Deploy

```bash
cd infra/cdk

cdk deploy \
  -c appVersion=0.1.1 \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

Optionally restrict health endpoint:

```bash
cdk deploy \
  -c allowedHealthCidr=203.0.113.4/32 \
  -c appVersion=0.1.1 \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

## QR Linking

On first boot, read logs and scan the QR code:

- Use SSM Session Manager (recommended) or SSH if you enable it.
- Then:

```bash
cd /opt/garbanzo/garbanzo-bot
APP_VERSION=0.1.1 docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f garbanzo
```
