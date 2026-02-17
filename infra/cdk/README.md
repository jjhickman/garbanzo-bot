# Garbanzo AWS CDK
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


This CDK app provisions two deployment patterns:

- EC2 + Docker Compose (SQLite + persistent Baileys auth)
- ECS Fargate + RDS Postgres (Phase 2 target for Slack/Discord official runtimes)

## Why EC2?

- SQLite works best on local disk (EBS)
- Baileys auth requires persistence
- Fargate + EFS is possible but adds complexity and can be harder to debug

## Why ECS + RDS?

- Better fit for official webhook-style runtimes (Slack/Discord)
- Managed orchestration + easier scaling knobs
- Postgres removes SQLite multi-writer constraints

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
  -c appVersion=0.1.8 \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

Hardened (private subnets + NAT; no public IP; access via SSM):

```bash
cdk deploy \
  -c networkMode=private \
  -c appVersion=0.1.8 \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

Note: private mode creates a new VPC and a NAT gateway (ongoing cost).

Optionally restrict health endpoint (only useful if you have VPC connectivity to the instance):

```bash
cdk deploy \
  -c allowedHealthCidr=203.0.113.4/32 \
  -c appVersion=0.1.8 \
  -c envParamName=/garbanzo/prod/env \
  -c groupsParamName=/garbanzo/prod/groups_json
```

## Deploy ECS + RDS stack (Phase 2 target)

Before deploying from repo root, run:

```bash
npm run aws:ecs:preflight
```

This validates AWS auth, bootstrap status, Route53 zone/certificate, and required Secrets Manager keys.

Then run:

```bash
npm run aws:ecs:audit
```

This performs an automated CDK synth audit for ECS task definitions, ECR pull authorization policies, and demo abuse-control resources before deploy.

This stack deploys:

- VPC (public + private + isolated subnets)
- ECS Fargate services for Slack and/or Discord runtimes
- ALB routing:
  - `/slack/events*` -> Slack service
  - `/discord/interactions*` -> Discord service
- RDS Postgres (encrypted, backup retention, snapshot delete policy)
- Secrets wiring for platform credentials + Postgres credentials

### Required contexts

```bash
-c deployEc2=false
-c deployEcs=true
-c ownerJid=<owner-id>
-c slackSecretArn=<secret arn or secret name>
-c discordSecretArn=<secret arn or secret name>
-c aiSecretArn=<secret arn or secret name>
-c featureSecretArn=<secret arn or secret name>  # defaults to aiSecretArn when omitted
```

`slackSecretArn` secret JSON must include:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`

`discordSecretArn` secret JSON must include:

- `DISCORD_BOT_TOKEN`
- `DISCORD_PUBLIC_KEY`

`aiSecretArn` secret JSON must include at least one of:

- `OPENROUTER_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`

`featureSecretArn` secret JSON must include:

- `GOOGLE_API_KEY`
- `MBTA_API_KEY`
- `NEWSAPI_KEY`
- `BRAVE_SEARCH_API_KEY`

### Optional contexts

```bash
-c appVersion=0.1.8
-c imageRepo=jjhickman/garbanzo
-c imageTag=0.1.8
-c aiProviderOrder=openrouter,anthropic,openai,gemini
-c vectorEmbeddingProvider=deterministic
-c vectorEmbeddingModel=text-embedding-3-small
-c vectorEmbeddingTimeoutMs=12000
-c vectorEmbeddingMaxChars=4000
-c bedrockRegion=us-east-1
-c bedrockModelId=anthropic.claude-3-5-haiku-20241022-v1:0
-c dbDeletionProtection=false
-c deploySlack=true
-c deployDiscord=true
-c deployDemo=false
-c slackDesiredCount=1
-c discordDesiredCount=1
-c demoDesiredCount=1
-c demoMinCapacity=1
-c demoMaxCapacity=2
-c demoRequestsPerTarget=25
-c demo5xxAlarmThreshold=10
-c demoP95LatencyMsThreshold=2500
-c demoRequestBurstThreshold=500
-c demoWafRateLimit=300
-c demoPort=3004
-c demoSecretArn=garbanzo/demo
-c demoTurnstileEnabled=true
-c demoAiProviderOrder=openrouter,openai,anthropic
-c demoOpenRouterModel=openai/gpt-4.1-mini
-c demoOpenAiModel=gpt-4.1-mini
-c demoVectorEmbeddingProvider=deterministic
-c demoVectorEmbeddingModel=text-embedding-3-small
-c demoAnthropicModel=claude-3-5-haiku-20241022
-c demoGeminiModel=gemini-1.5-flash
-c demoBedrockModelId=anthropic.claude-3-5-haiku-20241022-v1:0
-c demoBedrockMaxTokens=256
-c demoCloudMaxTokens=384
-c demoRequestTimeoutMs=12000
-c demoVectorEmbeddingTimeoutMs=12000
-c demoVectorEmbeddingMaxChars=4000
-c domainName=bot.garbanzobot.com
-c demoDomainName=demo.garbanzobot.com
-c hostedZoneName=garbanzobot.com
-c hostedZoneId=Z123456789ABC
-c certificateArn=arn:aws:acm:...
-c demoCertificateArn=arn:aws:acm:...
```

If you set `hostedZoneId` and `hostedZoneName` together, CDK skips Route53 lookup calls and does not require context-provider lookups during synth.

`deployDemo=true` provisions a public Slack demo runtime (no Slack API credentials required) so visitors can try Garbanzo over HTTP JSON.
Use `demoDomainName` to map a separate subdomain (for example `demo.garbanzobot.com`) to that runtime.

`demoSecretArn` should reference a Secrets Manager JSON secret with:
- `DEMO_TURNSTILE_SITE_KEY`
- `DEMO_TURNSTILE_SECRET_KEY`

The stack applies demo-host scoped AWS WAF protection (rate limit + managed common/bot rules), CloudWatch alarms, and bounded ECS autoscaling for abuse control.

Example:

```bash
cd infra/cdk

cdk deploy GarbanzoEcsStack \
  -c deployEc2=false \
  -c deployEcs=true \
  -c appVersion=0.1.8 \
  -c ownerJid=U0123456789 \
  -c slackSecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:garbanzo/slack-abc123 \
  -c discordSecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:garbanzo/discord-def456 \
  -c aiSecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:garbanzo/ai-ghi789 \
  -c featureSecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:garbanzo/features-jkl012 \
  -c domainName=bot.garbanzobot.com \
  -c hostedZoneName=garbanzobot.com \
  -c hostedZoneId=Z123456789ABC \
  -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/xxxx
```

Demo subdomain example:

```bash
cdk deploy GarbanzoEcsStack \
  -c deployEc2=false \
  -c deployEcs=true \
  -c deploySlack=true \
  -c deployDiscord=true \
  -c deployDemo=true \
  -c ownerJid=U0123456789 \
  -c slackSecretArn=garbanzo/slack \
  -c discordSecretArn=garbanzo/discord \
  -c aiSecretArn=garbanzo/ai \
  -c featureSecretArn=garbanzo/features \
  -c demoSecretArn=garbanzo/demo \
  -c demoTurnstileEnabled=true \
  -c demoAiProviderOrder=openrouter,openai,anthropic \
  -c demoOpenRouterModel=openai/gpt-4.1-mini \
  -c demoOpenAiModel=gpt-4.1-mini \
  -c demoVectorEmbeddingProvider=deterministic \
  -c demoVectorEmbeddingModel=text-embedding-3-small \
  -c demoAnthropicModel=claude-3-5-haiku-20241022 \
  -c demoBedrockMaxTokens=256 \
  -c demoCloudMaxTokens=384 \
  -c demoRequestTimeoutMs=12000 \
  -c demoVectorEmbeddingTimeoutMs=12000 \
  -c demoVectorEmbeddingMaxChars=4000 \
  -c domainName=bot.garbanzobot.com \
  -c demoDomainName=demo.garbanzobot.com \
  -c hostedZoneName=garbanzobot.com \
  -c hostedZoneId=Z123456789ABC \
  -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/xxxx \
  -c demoCertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/yyyy
```

After deploy, validate demo runtime:

```bash
curl -s https://demo.garbanzobot.com/slack/demo
curl -s https://demo.garbanzobot.com/discord/demo

curl -s -X POST https://demo.garbanzobot.com/demo/chat \
  -H 'content-type: application/json' \
  -d '{"platform":"slack","text":"@garbanzo what can you do?","turnstileToken":"<token>"}'
```

## QR Linking

On first boot, you need to read logs and scan the QR code.

This CDK stack configures Docker Compose to ship container logs to CloudWatch Logs via the `awslogs` driver.

Options:

- Preferred: view logs in CloudWatch Logs (Log Group: `/garbanzo/prod` by default)
- Alternate: SSM Session Manager and run `docker compose logs -f garbanzo`
