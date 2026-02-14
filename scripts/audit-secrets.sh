#!/bin/bash
# Garbanzo Bot — Secret/Credential Audit (powered by gitleaks)
# Scans tracked files for hardcoded API keys, tokens, and sensitive data.
#
# Exit codes: 0 = clean, 1 = secrets found, 2 = gitleaks not installed
#
# Usage:
#   ./scripts/audit-secrets.sh              # Scan all tracked files
#   ./scripts/audit-secrets.sh --staged     # Scan only staged files (pre-commit)
#   ./scripts/audit-secrets.sh --verbose    # Show detailed findings
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Check gitleaks is installed ───────────────────────────────────────
if ! command -v gitleaks &>/dev/null; then
  echo -e "${RED}${BOLD}ERROR${NC}: gitleaks is not installed."
  echo ""
  echo "Install with:"
  echo "  brew install gitleaks"
  echo "  # or: go install github.com/gitleaks/gitleaks/v8@latest"
  echo ""
  echo "See: https://github.com/gitleaks/gitleaks#installing"
  exit 2
fi

# ─── Parse arguments ──────────────────────────────────────────────────
MODE="dir"
VERBOSE=""
for arg in "$@"; do
  case "$arg" in
    --staged)  MODE="staged" ;;
    --verbose|-v) VERBOSE="--verbose" ;;
  esac
done

echo -e "${BOLD}Secret Audit${NC} (gitleaks $(gitleaks version))"
echo -e "Mode: ${MODE}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── Run gitleaks ─────────────────────────────────────────────────────
# --exit-code 1: exit 1 if leaks found
# --config: use project .gitleaks.toml
# --redact: redact secrets in output (safety)
# --no-banner: clean output

GITLEAKS_ARGS=(
  --config "${PROJECT_DIR}/.gitleaks.toml"
  --exit-code 1
  --redact
  --no-banner
)

if [[ -n "$VERBOSE" ]]; then
  GITLEAKS_ARGS+=(--verbose)
fi

EXIT_CODE=0

if [[ "$MODE" == "staged" ]]; then
  # Pre-commit mode: only scan staged changes
  gitleaks git --staged "${GITLEAKS_ARGS[@]}" || EXIT_CODE=$?
else
  # Full scan: scan the working directory (respects .gitleaks.toml path allowlist)
  gitleaks dir "${GITLEAKS_ARGS[@]}" || EXIT_CODE=$?
fi

# ─── Report ───────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}PASSED${NC} — No secrets found."
elif [[ $EXIT_CODE -eq 1 ]]; then
  echo -e "${RED}${BOLD}FAILED${NC} — Secrets detected in tracked files."
  echo ""
  echo "To fix:"
  echo "  1. Move secrets to .env (gitignored)"
  echo "  2. Reference via process.env.VAR_NAME in code"
  echo "  3. For test files, use fake values (test_xxx, 5550001234)"
  echo ""
  echo "To allowlist a false positive:"
  echo "  - Add a path to [allowlist].paths in .gitleaks.toml"
  echo "  - Or add 'gitleaks:allow' as an inline comment"
  echo ""
  echo "Run with --verbose for detailed findings."
else
  echo -e "${YELLOW}${BOLD}WARNING${NC} — gitleaks exited with code ${EXIT_CODE}."
fi

exit $EXIT_CODE
