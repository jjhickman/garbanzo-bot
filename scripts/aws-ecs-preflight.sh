#!/bin/bash
set -euo pipefail

# AWS ECS preflight checks for Garbanzo Phase 2 deploy.
#
# Validates:
# - AWS auth/session
# - region + account
# - CDK bootstrap parameter
# - Route53 hosted zone
# - ACM certificate
# - runtime secrets for Slack/Discord
#
# Prints a ready-to-run CDK deploy command template at the end.

DOMAIN_NAME="bot.garbanzobot.com"
HOSTED_ZONE_NAME="garbanzobot.com"
HOSTED_ZONE_ID=""
CERTIFICATE_ARN=""
SLACK_SECRET_NAME="garbanzo/slack"
DISCORD_SECRET_NAME="garbanzo/discord"
DEMO_SECRET_NAME="garbanzo/demo"
AI_SECRET_NAME="garbanzo/ai"
OWNER_ID=""
REGION=""
DEPLOY_DEMO="false"
DEMO_DOMAIN_NAME=""
DEMO_CERTIFICATE_ARN=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/aws-ecs-preflight.sh [options]

Options:
  --domain-name <name>         Domain record to create (default: bot.garbanzobot.com)
  --hosted-zone-name <name>    Route53 zone name (default: garbanzobot.com)
  --hosted-zone-id <id>        Explicit Route53 hosted zone id (optional)
  --certificate-arn <arn>      ACM cert ARN in deploy region (optional)
  --slack-secret <name>        Secrets Manager name for Slack (default: garbanzo/slack)
  --discord-secret <name>      Secrets Manager name for Discord (default: garbanzo/discord)
  --demo-secret <name>         Secrets Manager name for demo challenge keys (default: garbanzo/demo)
  --ai-secret <name>           Secrets Manager name for AI provider keys (default: garbanzo/ai)
  --owner-id <id>              Owner ID for platform runtime (optional)
  --region <region>            AWS region override (defaults to AWS CLI config)
  --deploy-demo <true|false>   Enable demo runtime contexts in output (default: false)
  --demo-domain-name <name>    Demo subdomain (for example demo.garbanzobot.com)
  --demo-certificate-arn <arn> ACM cert ARN for demo domain (optional)
  -h, --help                   Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain-name)
      DOMAIN_NAME="${2:-}"
      shift 2
      ;;
    --hosted-zone-name)
      HOSTED_ZONE_NAME="${2:-}"
      shift 2
      ;;
    --hosted-zone-id)
      HOSTED_ZONE_ID="${2:-}"
      shift 2
      ;;
    --certificate-arn)
      CERTIFICATE_ARN="${2:-}"
      shift 2
      ;;
    --slack-secret)
      SLACK_SECRET_NAME="${2:-}"
      shift 2
      ;;
    --discord-secret)
      DISCORD_SECRET_NAME="${2:-}"
      shift 2
      ;;
    --demo-secret)
      DEMO_SECRET_NAME="${2:-}"
      shift 2
      ;;
    --ai-secret)
      AI_SECRET_NAME="${2:-}"
      shift 2
      ;;
    --owner-id)
      OWNER_ID="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --deploy-demo)
      DEPLOY_DEMO="${2:-}"
      shift 2
      ;;
    --demo-domain-name)
      DEMO_DOMAIN_NAME="${2:-}"
      shift 2
      ;;
    --demo-certificate-arn)
      DEMO_CERTIFICATE_ARN="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REGION" ]]; then
  REGION="$(aws configure get region || true)"
fi

if [[ -z "$REGION" ]]; then
  echo "No AWS region configured. Set with --region or 'aws configure set region <region>'." >&2
  exit 2
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required but not found in PATH" >&2
  exit 2
fi

DEPLOY_DEMO="$(printf '%s' "$DEPLOY_DEMO" | tr '[:upper:]' '[:lower:]')"
if [[ "$DEPLOY_DEMO" != "true" && "$DEPLOY_DEMO" != "false" ]]; then
  echo "--deploy-demo must be true or false" >&2
  exit 1
fi

echo "== Garbanzo ECS Preflight =="
echo "Domain:           $DOMAIN_NAME"
echo "Hosted zone name: $HOSTED_ZONE_NAME"
echo "Region:           $REGION"
echo "Deploy demo:      $DEPLOY_DEMO"
if [[ "$DEPLOY_DEMO" == "true" ]]; then
  if [[ -z "$DEMO_DOMAIN_NAME" ]]; then
    DEMO_DOMAIN_NAME="demo.${HOSTED_ZONE_NAME}"
  fi
  echo "Demo domain:      $DEMO_DOMAIN_NAME"
fi

IDENTITY_JSON="$(aws sts get-caller-identity --region "$REGION" --output json)"
ACCOUNT_ID="$(aws sts get-caller-identity --region "$REGION" --query 'Account' --output text)"
ARN="$(aws sts get-caller-identity --region "$REGION" --query 'Arn' --output text)"

echo "Account:          $ACCOUNT_ID"
echo "Caller ARN:       $ARN"

BOOTSTRAP_VERSION="$(aws ssm get-parameter --region "$REGION" --name /cdk-bootstrap/hnb659fds/version --query 'Parameter.Value' --output text)"
echo "CDK bootstrap:    /cdk-bootstrap/hnb659fds/version=$BOOTSTRAP_VERSION"

if [[ -z "$HOSTED_ZONE_ID" ]]; then
  ZONE_ID_RAW="$(aws route53 list-hosted-zones-by-name --dns-name "$HOSTED_ZONE_NAME" --max-items 10 --query "HostedZones[?Name=='${HOSTED_ZONE_NAME}.'].Id | [0]" --output text)"
  if [[ -z "$ZONE_ID_RAW" || "$ZONE_ID_RAW" == "None" ]]; then
    echo "Hosted zone not found for $HOSTED_ZONE_NAME" >&2
    exit 3
  fi
  HOSTED_ZONE_ID="${ZONE_ID_RAW##*/}"
fi

aws route53 get-hosted-zone --id "$HOSTED_ZONE_ID" >/dev/null

echo "Hosted zone id:   $HOSTED_ZONE_ID"

if [[ -z "$CERTIFICATE_ARN" ]]; then
  CERTIFICATE_ARN="$(aws acm list-certificates --region "$REGION" --certificate-statuses ISSUED --query "CertificateSummaryList[?DomainName=='${HOSTED_ZONE_NAME}'].CertificateArn | [0]" --output text)"
fi

if [[ -z "$CERTIFICATE_ARN" || "$CERTIFICATE_ARN" == "None" ]]; then
  echo "No issued ACM cert found for $HOSTED_ZONE_NAME in $REGION" >&2
  exit 4
fi

aws acm describe-certificate --region "$REGION" --certificate-arn "$CERTIFICATE_ARN" >/dev/null
echo "Certificate ARN:  $CERTIFICATE_ARN"

if [[ "$DEPLOY_DEMO" == "true" ]]; then
  if [[ -z "$DEMO_CERTIFICATE_ARN" ]]; then
    DEMO_CERTIFICATE_ARN="$(aws acm list-certificates --region "$REGION" --certificate-statuses ISSUED --query "CertificateSummaryList[?DomainName=='${DEMO_DOMAIN_NAME}'].CertificateArn | [0]" --output text)"
    if [[ "$DEMO_CERTIFICATE_ARN" == "None" ]]; then
      DEMO_CERTIFICATE_ARN=""
    fi
  fi

  if [[ -n "$DEMO_CERTIFICATE_ARN" ]]; then
    aws acm describe-certificate --region "$REGION" --certificate-arn "$DEMO_CERTIFICATE_ARN" >/dev/null
    echo "Demo cert ARN:    $DEMO_CERTIFICATE_ARN"
  else
    echo "Demo cert ARN:    (not set - stack can auto-issue via hosted zone)"
  fi
fi

SLACK_SECRET_OK="false"
DISCORD_SECRET_OK="false"
DEMO_SECRET_OK="false"
AI_SECRET_OK="false"

if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SLACK_SECRET_NAME" >/dev/null 2>&1; then
  SLACK_SECRET_OK="true"
fi

if aws secretsmanager describe-secret --region "$REGION" --secret-id "$DISCORD_SECRET_NAME" >/dev/null 2>&1; then
  DISCORD_SECRET_OK="true"
fi

if [[ "$DEPLOY_DEMO" == "true" ]] && aws secretsmanager describe-secret --region "$REGION" --secret-id "$DEMO_SECRET_NAME" >/dev/null 2>&1; then
  DEMO_SECRET_OK="true"
fi

if aws secretsmanager describe-secret --region "$REGION" --secret-id "$AI_SECRET_NAME" >/dev/null 2>&1; then
  AI_SECRET_OK="true"
fi

echo "Slack secret:     $SLACK_SECRET_NAME ($SLACK_SECRET_OK)"
echo "Discord secret:   $DISCORD_SECRET_NAME ($DISCORD_SECRET_OK)"
echo "AI secret:        $AI_SECRET_NAME ($AI_SECRET_OK)"
if [[ "$DEPLOY_DEMO" == "true" ]]; then
  echo "Demo secret:      $DEMO_SECRET_NAME ($DEMO_SECRET_OK)"
fi

if [[ "$SLACK_SECRET_OK" != "true" || "$DISCORD_SECRET_OK" != "true" || "$AI_SECRET_OK" != "true" || ( "$DEPLOY_DEMO" == "true" && "$DEMO_SECRET_OK" != "true" ) ]]; then
  echo
  echo "Missing runtime secret(s). Create them with JSON values before deploy:"
  if [[ "$SLACK_SECRET_OK" != "true" ]]; then
    cat <<EOF
aws secretsmanager create-secret --region $REGION \\
  --name $SLACK_SECRET_NAME \\
  --secret-string '{"SLACK_BOT_TOKEN":"__SET_ME__","SLACK_SIGNING_SECRET":"__SET_ME__"}'
EOF
  fi
  if [[ "$DISCORD_SECRET_OK" != "true" ]]; then
    cat <<EOF
aws secretsmanager create-secret --region $REGION \\
  --name $DISCORD_SECRET_NAME \\
  --secret-string '{"DISCORD_BOT_TOKEN":"__SET_ME__","DISCORD_PUBLIC_KEY":"__SET_ME__"}'
EOF
  fi
  if [[ "$DEPLOY_DEMO" == "true" && "$DEMO_SECRET_OK" != "true" ]]; then
    cat <<EOF
aws secretsmanager create-secret --region $REGION \\
  --name $DEMO_SECRET_NAME \\
  --secret-string '{"DEMO_TURNSTILE_SITE_KEY":"__SET_ME__","DEMO_TURNSTILE_SECRET_KEY":"__SET_ME__"}'
EOF
  fi
  if [[ "$AI_SECRET_OK" != "true" ]]; then
    cat <<EOF
aws secretsmanager create-secret --region $REGION \\
  --name $AI_SECRET_NAME \\
  --secret-string '{"OPENROUTER_API_KEY":"__SET_ME__","ANTHROPIC_API_KEY":"__SET_ME__","OPENAI_API_KEY":"__SET_ME__"}'
EOF
  fi
fi

OWNER_ARG='-c ownerJid=<SET_OWNER_ID>'
if [[ -n "$OWNER_ID" ]]; then
  OWNER_ARG="-c ownerJid=$OWNER_ID"
fi

echo
echo "Deploy command template:"
echo "cd infra/cdk"
echo "npm run deploy -- GarbanzoEcsStack \\" 
echo "  -c deployEc2=false \\" 
echo "  -c deployEcs=true \\" 
echo "  -c appVersion=0.1.8 \\" 
echo "  $OWNER_ARG \\" 
echo "  -c slackSecretArn=$SLACK_SECRET_NAME \\" 
echo "  -c discordSecretArn=$DISCORD_SECRET_NAME \\" 
echo "  -c aiSecretArn=$AI_SECRET_NAME \\" 
echo "  -c domainName=$DOMAIN_NAME \\" 
echo "  -c hostedZoneName=$HOSTED_ZONE_NAME \\" 
echo "  -c hostedZoneId=$HOSTED_ZONE_ID \\" 
if [[ "$DEPLOY_DEMO" == "true" ]]; then
  echo "  -c deployDemo=true \\" 
  echo "  -c demoDomainName=$DEMO_DOMAIN_NAME \\" 
  echo "  -c demoSecretArn=$DEMO_SECRET_NAME \\" 
  echo "  -c demoTurnstileEnabled=true \\" 
  if [[ -n "$DEMO_CERTIFICATE_ARN" ]]; then
    echo "  -c demoCertificateArn=$DEMO_CERTIFICATE_ARN \\" 
  fi
fi
echo "  -c certificateArn=$CERTIFICATE_ARN"

if [[ "$SLACK_SECRET_OK" == "true" && "$DISCORD_SECRET_OK" == "true" && "$AI_SECRET_OK" == "true" && ( "$DEPLOY_DEMO" != "true" || "$DEMO_SECRET_OK" == "true" ) ]]; then
  echo
  echo "Preflight status: READY"
else
  echo
  echo "Preflight status: BLOCKED (missing secrets)"
  exit 5
fi
