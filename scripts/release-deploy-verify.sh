#!/bin/bash
set -euo pipefail

# Deploy a specific Garbanzo release image and verify /health + /health/ready.
#
# Usage:
#   bash scripts/release-deploy-verify.sh --version 0.1.6
#   bash scripts/release-deploy-verify.sh --version 0.1.6 --rollback-version 0.1.5
#
# Notes:
# - Defaults to docker-compose.yml + docker-compose.prod.yml
# - Uses APP_VERSION env var for pull/up commands

VERSION=""
ROLLBACK_VERSION=""
COMPOSE_FILES="docker-compose.yml,docker-compose.prod.yml"
SERVICE="garbanzo"
HEALTH_URL="http://127.0.0.1:3001/health"
READY_URL="http://127.0.0.1:3001/health/ready"
RETRIES=30
SLEEP_SECONDS=2
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release-deploy-verify.sh --version <X.Y.Z> [options]

Options:
  --version <X.Y.Z>            Release version to deploy (required)
  --rollback-version <X.Y.Z>   Optional fallback version if verification fails
  --compose-files <csv>        Compose files (default: docker-compose.yml,docker-compose.prod.yml)
  --service <name>             Compose service name (default: garbanzo)
  --health-url <url>           Health endpoint (default: http://127.0.0.1:3001/health)
  --ready-url <url>            Readiness endpoint (default: http://127.0.0.1:3001/health/ready)
  --retries <n>                Verification attempts (default: 30)
  --sleep <seconds>            Delay between attempts (default: 2)
  --dry-run                    Print commands only
  -h, --help                   Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --rollback-version)
      ROLLBACK_VERSION="${2:-}"
      shift 2
      ;;
    --rollback-version=*)
      ROLLBACK_VERSION="${1#--rollback-version=}"
      shift
      ;;
    --compose-files)
      COMPOSE_FILES="${2:-}"
      shift 2
      ;;
    --compose-files=*)
      COMPOSE_FILES="${1#--compose-files=}"
      shift
      ;;
    --service)
      SERVICE="${2:-}"
      shift 2
      ;;
    --service=*)
      SERVICE="${1#--service=}"
      shift
      ;;
    --health-url)
      HEALTH_URL="${2:-}"
      shift 2
      ;;
    --health-url=*)
      HEALTH_URL="${1#--health-url=}"
      shift
      ;;
    --ready-url)
      READY_URL="${2:-}"
      shift 2
      ;;
    --ready-url=*)
      READY_URL="${1#--ready-url=}"
      shift
      ;;
    --retries)
      RETRIES="${2:-}"
      shift 2
      ;;
    --retries=*)
      RETRIES="${1#--retries=}"
      shift
      ;;
    --sleep)
      SLEEP_SECONDS="${2:-}"
      shift 2
      ;;
    --sleep=*)
      SLEEP_SECONDS="${1#--sleep=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
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

if [[ -z "$VERSION" ]]; then
  echo "--version is required" >&2
  usage >&2
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid --version value: $VERSION" >&2
  exit 1
fi

if [[ -n "$ROLLBACK_VERSION" ]] && ! [[ "$ROLLBACK_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid --rollback-version value: $ROLLBACK_VERSION" >&2
  exit 1
fi

if [[ "$DRY_RUN" != "true" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required but not found in PATH" >&2
    exit 2
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required but not found in PATH" >&2
    exit 2
  fi
fi

if ! [[ "$RETRIES" =~ ^[0-9]+$ ]] || [[ "$RETRIES" -lt 1 ]]; then
  echo "--retries must be a positive integer" >&2
  exit 1
fi

if ! [[ "$SLEEP_SECONDS" =~ ^[0-9]+$ ]] || [[ "$SLEEP_SECONDS" -lt 1 ]]; then
  echo "--sleep must be a positive integer" >&2
  exit 1
fi

IFS=',' read -r -a FILE_LIST <<< "$COMPOSE_FILES"
COMPOSE_CMD=(docker compose)

for file in "${FILE_LIST[@]}"; do
  trimmed="$(printf '%s' "$file" | xargs)"
  if [[ -n "$trimmed" ]]; then
    COMPOSE_CMD+=(-f "$trimmed")
  fi
done

run_compose_deploy() {
  local deploy_version="$1"

  local pull_cmd=("${COMPOSE_CMD[@]}" pull "$SERVICE")
  local up_cmd=("${COMPOSE_CMD[@]}" up -d "$SERVICE")

  echo "Deploying version $deploy_version"
  echo "- APP_VERSION=$deploy_version ${pull_cmd[*]}"
  echo "- APP_VERSION=$deploy_version ${up_cmd[*]}"

  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi

  APP_VERSION="$deploy_version" "${pull_cmd[@]}"
  APP_VERSION="$deploy_version" "${up_cmd[@]}"
}

verify_endpoints() {
  local health_ok=false
  local ready_ok=false

  echo "Verifying endpoints"
  echo "- health: $HEALTH_URL"
  echo "- ready:  $READY_URL"

  for ((i = 1; i <= RETRIES; i++)); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      health_ok=true
    fi

    if curl -fsS "$READY_URL" >/dev/null 2>&1; then
      ready_ok=true
    fi

    if [[ "$health_ok" == "true" && "$ready_ok" == "true" ]]; then
      echo "Verification passed on attempt $i/$RETRIES"
      return 0
    fi

    sleep "$SLEEP_SECONDS"
  done

  echo "Verification failed after $RETRIES attempts" >&2
  echo "- health_ok=$health_ok" >&2
  echo "- ready_ok=$ready_ok" >&2
  return 1
}

run_compose_deploy "$VERSION"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete. No changes applied."
  exit 0
fi

if verify_endpoints; then
  echo "Deploy + verify complete for version $VERSION"
  exit 0
fi

if [[ -n "$ROLLBACK_VERSION" ]]; then
  echo "Attempting rollback to version $ROLLBACK_VERSION" >&2
  run_compose_deploy "$ROLLBACK_VERSION"
  if verify_endpoints; then
    echo "Rollback successful to version $ROLLBACK_VERSION" >&2
  else
    echo "Rollback verification failed for version $ROLLBACK_VERSION" >&2
  fi
fi

exit 1
