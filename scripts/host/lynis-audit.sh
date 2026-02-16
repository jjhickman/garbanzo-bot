#!/bin/bash
set -euo pipefail

# Host hardening helper: run a Lynis system audit.
#
# Safe by default:
# - If lynis is not installed, prints install instructions and exits.
# - Writes captured output into ./data/host-audits (gitignored).
#
# Usage:
#   bash scripts/host/lynis-audit.sh
#   bash scripts/host/lynis-audit.sh --install
#
# Notes:
# - Requires sudo to run the audit.

INSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL=true
      shift
      ;;
    -h|--help)
      echo "Usage: bash scripts/host/lynis-audit.sh [--install]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v lynis >/dev/null 2>&1; then
  if [[ "$INSTALL" != "true" ]]; then
    echo "Lynis is not installed." >&2
    echo "Install (Debian/Ubuntu): sudo apt-get update && sudo apt-get install -y lynis" >&2
    echo "Or rerun with: bash scripts/host/lynis-audit.sh --install" >&2
    exit 2
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "apt-get not found; install lynis manually for your distro." >&2
    exit 2
  fi

  sudo apt-get update
  sudo apt-get install -y lynis
fi

mkdir -p data/host-audits
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="data/host-audits/lynis-${STAMP}.txt"

# Run the audit and capture output. Keep stdout/stderr together.
# Lynis writes additional logs under /var/log (root-owned).
{
  echo "=== Lynis audit started: $(date -Is) ==="
  echo "Command: sudo lynis audit system"
  echo
  sudo lynis audit system --quick --no-colors
  echo
  echo "=== Lynis audit finished: $(date -Is) ==="
} >"$OUT" 2>&1

echo "Wrote: $OUT"

# Best-effort copy of Lynis report files if present.
if [[ -f /var/log/lynis-report.dat ]]; then
  cp /var/log/lynis-report.dat "data/host-audits/lynis-report-${STAMP}.dat" 2>/dev/null || true
fi
if [[ -f /var/log/lynis.log ]]; then
  cp /var/log/lynis.log "data/host-audits/lynis-log-${STAMP}.log" 2>/dev/null || true
fi
