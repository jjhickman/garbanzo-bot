#!/bin/bash
set -euo pipefail

# Lightweight journal scanner for Garbanzo.
#
# Usage:
#   bash scripts/journal-scan.sh [--unit <unit>] [--since <since>] [--grep <pattern>]
#
# Examples:
#   bash scripts/journal-scan.sh --unit garbanzo.service --since "24 hours ago"
#   bash scripts/journal-scan.sh --unit garbanzo.service --since "1 hour ago" --grep "ERR|FATAL"

UNIT="garbanzo.service"
SINCE="24 hours ago"
GREP_PATTERN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)
      UNIT="${2:-}"
      shift 2
      ;;
    --since)
      SINCE="${2:-}"
      shift 2
      ;;
    --grep)
      GREP_PATTERN="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: bash scripts/journal-scan.sh [--unit <unit>] [--since <since>] [--grep <pattern>]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v journalctl >/dev/null 2>&1; then
  echo "journalctl not found on this system." >&2
  exit 2
fi

CMD=(journalctl --no-pager --user -u "$UNIT" --since "$SINCE")

if [[ -n "$GREP_PATTERN" ]]; then
  "${CMD[@]}" | grep -En "$GREP_PATTERN" || true
else
  "${CMD[@]}"
fi
