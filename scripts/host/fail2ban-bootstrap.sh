#!/bin/bash
set -euo pipefail

# Host hardening helper: bootstrap Fail2ban for SSH.
#
# Safe by default:
# - Prints current status and recommended config.
# - Only installs/writes config when --apply is passed.
#
# Usage:
#   bash scripts/host/fail2ban-bootstrap.sh
#   bash scripts/host/fail2ban-bootstrap.sh --apply
#   bash scripts/host/fail2ban-bootstrap.sh --apply --ignoreip "127.0.0.1/8 ::1 100.64.0.0/10 192.168.50.0/24"

APPLY=false
IGNOREIP="127.0.0.1/8 ::1"
MAXRETRY=5
FINDTIME="10m"
BANTIME="1h"
BACKEND="systemd"

ensure_sudo() {
  if sudo -n true >/dev/null 2>&1; then
    return 0
  fi

  if [[ -t 0 ]]; then
    echo "Sudo privileges are required; prompting for password..."
    sudo -v
    return 0
  fi

  echo "Sudo privileges are required, but no interactive TTY is available." >&2
  echo "Run this command in an interactive shell, then retry." >&2
  exit 3
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    --ignoreip)
      IGNOREIP="${2:-}"
      shift 2
      ;;
    --maxretry)
      MAXRETRY="${2:-}"
      shift 2
      ;;
    --findtime)
      FINDTIME="${2:-}"
      shift 2
      ;;
    --bantime)
      BANTIME="${2:-}"
      shift 2
      ;;
    --backend)
      BACKEND="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: bash scripts/host/fail2ban-bootstrap.sh [--apply] [--ignoreip <list>] [--maxretry N] [--findtime 10m] [--bantime 1h] [--backend systemd]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

RECOMMENDED_FILE="/etc/fail2ban/jail.d/garbanzo-sshd.local"

cat <<EOF
Fail2ban bootstrap (SSH)

Recommended jail file: ${RECOMMENDED_FILE}

[sshd]
enabled = true
backend = ${BACKEND}
maxretry = ${MAXRETRY}
findtime = ${FINDTIME}
bantime = ${BANTIME}
ignoreip = ${IGNOREIP}
EOF

if [[ "$APPLY" != "true" ]]; then
  echo
  echo "Dry run only. To apply (requires sudo):"
  echo "  bash scripts/host/fail2ban-bootstrap.sh --apply"
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get not found; install fail2ban manually for your distro." >&2
  exit 2
fi

ensure_sudo
sudo apt-get update
sudo apt-get install -y fail2ban

# Write jail override in a safe override directory.
TMP_FILE="$(mktemp)"
cat >"$TMP_FILE" <<EOF
[sshd]
enabled = true
backend = ${BACKEND}
maxretry = ${MAXRETRY}
findtime = ${FINDTIME}
bantime = ${BANTIME}
ignoreip = ${IGNOREIP}
EOF

sudo mkdir -p "$(dirname "$RECOMMENDED_FILE")"
sudo cp "$TMP_FILE" "$RECOMMENDED_FILE"
rm -f "$TMP_FILE"

sudo systemctl enable --now fail2ban

echo
echo "Applied jail config: $RECOMMENDED_FILE"
echo "Check status: sudo systemctl status fail2ban --no-pager"
echo "Check jail:  sudo fail2ban-client status sshd"
