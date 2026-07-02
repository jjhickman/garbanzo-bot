#!/usr/bin/env bash
# backup-install.sh — install a nightly systemd timer for garbanzo backups.
#
# Usage:
#   sudo bash scripts/host/backup-install.sh [--dest DIR] [--time HH:MM] [--dry-run]
#   sudo bash scripts/host/backup-install.sh --uninstall
#
# Copies garbanzo-backup.sh to /usr/local/bin, writes an env file to
# /etc/default/garbanzo-backup, and installs garbanzo-backup.{service,timer}
# (daily at 03:30 by default, persistent across missed runs).
#
# --dry-run prints the generated units without touching the system.

set -euo pipefail

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

DEST="/media/josh/T9/garbanzo-backups"
TIME="03:30"
DRY=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dest) DEST="$2"; shift 2 ;;
    --time) TIME="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_UNIT="[Unit]
Description=Garbanzo volume backup to external disk
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
EnvironmentFile=-/etc/default/garbanzo-backup
ExecStart=/usr/local/bin/garbanzo-backup.sh
"

TIMER_UNIT="[Unit]
Description=Nightly garbanzo backup

[Timer]
OnCalendar=*-*-* ${TIME}:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
"

ENV_FILE="BACKUP_DEST=${DEST}
"

if [[ "$DRY" == "1" ]]; then
  echo "── /etc/systemd/system/garbanzo-backup.service ──"
  echo "$SERVICE_UNIT"
  echo "── /etc/systemd/system/garbanzo-backup.timer ──"
  echo "$TIMER_UNIT"
  echo "── /etc/default/garbanzo-backup ──"
  echo "$ENV_FILE"
  exit 0
fi

[[ "$(id -u)" == "0" ]] || { echo "run with sudo (installs systemd units)" >&2; exit 1; }

if [[ "$UNINSTALL" == "1" ]]; then
  systemctl disable --now garbanzo-backup.timer 2>/dev/null || true
  rm -f /etc/systemd/system/garbanzo-backup.service /etc/systemd/system/garbanzo-backup.timer \
        /usr/local/bin/garbanzo-backup.sh /etc/default/garbanzo-backup
  systemctl daemon-reload
  echo "garbanzo-backup timer removed"
  exit 0
fi

install -m 0755 "$SCRIPT_DIR/garbanzo-backup.sh" /usr/local/bin/garbanzo-backup.sh
printf '%s' "$ENV_FILE" > /etc/default/garbanzo-backup
printf '%s' "$SERVICE_UNIT" > /etc/systemd/system/garbanzo-backup.service
printf '%s' "$TIMER_UNIT" > /etc/systemd/system/garbanzo-backup.timer
systemctl daemon-reload
systemctl enable --now garbanzo-backup.timer

echo "Installed. Next runs:"
systemctl list-timers garbanzo-backup.timer --no-pager || true
echo
echo "Run one now with:   sudo systemctl start garbanzo-backup.service"
echo "Watch logs with:    journalctl -u garbanzo-backup.service -f"
