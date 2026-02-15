#!/bin/bash
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-jjhickman/garbanzo-bot}"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      cat <<EOF
Rotate GitHub Actions secrets from local environment variables.

Usage:
  OPENAI_API_KEY=... OPENROUTER_API_KEY=... bash scripts/rotate-gh-secrets.sh [--repo owner/repo] [--dry-run]

Recognized env vars:
  ANTHROPIC_API_KEY
  OPENROUTER_API_KEY
  OPENAI_API_KEY
  BRAVE_SEARCH_API_KEY
  GOOGLE_API_KEY
  MBTA_API_KEY
  NEWSAPI_KEY

Notes:
  - Secrets are read from your shell environment and piped directly to `gh secret set`.
  - No secret values are printed.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 1
fi

secret_names=(
  "ANTHROPIC_API_KEY"
  "OPENROUTER_API_KEY"
  "OPENAI_API_KEY"
  "BRAVE_SEARCH_API_KEY"
  "GOOGLE_API_KEY"
  "MBTA_API_KEY"
  "NEWSAPI_KEY"
)

rotated=0

for secret in "${secret_names[@]}"; do
  value="${!secret:-}"
  if [[ -z "$value" ]]; then
    continue
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] would update secret: $secret in $REPO"
  else
    printf '%s' "$value" | gh secret set "$secret" --repo "$REPO"
    echo "updated secret: $secret in $REPO"
  fi
  rotated=$((rotated + 1))
done

if [[ $rotated -eq 0 ]]; then
  echo "No secret environment variables provided; nothing to rotate."
  exit 1
fi

echo "Done. Processed $rotated secrets."
