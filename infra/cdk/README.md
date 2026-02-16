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

You have two options:

1) Recommended: create parameters out-of-band (does not store secrets in CloudFormation)

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

2) Optional: have CDK create placeholder parameters (values set to `__SET_ME__`)

```bash
cdk deploy \
  -c createParameters=true \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

After deploy, overwrite both parameters with real values using the AWS CLI.

## Deploy

### Deploy Garbanzo app (EC2)

Public subnet (default VPC; easiest to start):

```bash
cd infra/cdk

cdk deploy \
  -c appVersion=0.1.6 \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

Hardened (private subnets + NAT; no public IP; access via SSM):

```bash
cdk deploy \
  -c networkMode=private \
  -c appVersion=0.1.6 \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

Note: private mode creates a new VPC and a NAT gateway (ongoing cost).

Optionally restrict health endpoint (only useful if you have VPC connectivity to the instance):

```bash
cdk deploy \
  -c allowedHealthCidr=203.0.113.4/32 \
  -c appVersion=0.1.6 \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

## QR Linking

On first boot, you need to read logs and scan the QR code.

This CDK stack configures Docker Compose to ship container logs to CloudWatch Logs via the `awslogs` driver.

Options:

- Preferred: view logs in CloudWatch Logs (Log Group: `/garbanzo/prod` by default)
- Alternate: SSM Session Manager and run `docker compose logs -f garbanzo`
