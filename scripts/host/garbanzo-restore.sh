#!/usr/bin/env bash
# garbanzo-restore.sh — restore garbanzo Docker volumes from a backup archive.
#
# Usage:
#   bash scripts/host/garbanzo-restore.sh --list
#   bash scripts/host/garbanzo-restore.sh <archive.tar.gz|latest> [--promote-snapshot] [--force]
#
# Restores auth/ into the auth volume and data/ into the data volume.
# The stack must be stopped first (docker compose down — WITHOUT -v).
#
# --promote-snapshot  after restoring, replace data/garbanzo.db with the newest
#                     VACUUM'd snapshot from data/backups/ (use when the live
#                     db in the archive is suspect, e.g. after corruption)
# --force             skip the "container is running" abort
#
# Environment: BACKUP_DEST, AUTH_VOLUME, DATA_VOLUME, CONTAINER_NAME as in
# garbanzo-backup.sh.

set -euo pipefail

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}

BACKUP_DEST="${BACKUP_DEST:-/media/josh/T9/garbanzo-backups}"
AUTH_VOLUME="${AUTH_VOLUME:-garbanzo-bot-auth}"
DATA_VOLUME="${DATA_VOLUME:-garbanzo-bot-data}"
CONTAINER_NAME="${CONTAINER_NAME:-garbanzo}"

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

case "${1:-}" in
  --help|-h|'') usage; exit 0 ;;
  --list)
    ls -1t "$BACKUP_DEST"/garbanzo-backup-*.tar.gz 2>/dev/null || echo "No archives found in $BACKUP_DEST"
    exit 0 ;;
esac

ARCHIVE="$1"; shift
PROMOTE=0; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --promote-snapshot) PROMOTE=1 ;;
    --force) FORCE=1 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

if [[ "$ARCHIVE" == "latest" ]]; then
  ARCHIVE="$(ls -1t "$BACKUP_DEST"/garbanzo-backup-*.tar.gz 2>/dev/null | head -1)"
  [[ -n "$ARCHIVE" ]] || die "no archives in $BACKUP_DEST"
fi
[[ -f "$ARCHIVE" ]] || ARCHIVE="$BACKUP_DEST/$ARCHIVE"
[[ -f "$ARCHIVE" ]] || die "archive not found: $ARCHIVE"

if [[ -f "$ARCHIVE.sha256" ]]; then
  log "Verifying checksum"
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256") || die "checksum mismatch — do not restore from this archive"
fi

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME" && [[ "$FORCE" != "1" ]]; then
  die "$CONTAINER_NAME is running. Stop it first (docker compose down — never 'down -v') or pass --force"
fi

log "Restoring $ARCHIVE into $AUTH_VOLUME + $DATA_VOLUME"
docker run --rm \
  -v "$AUTH_VOLUME":/restore/auth \
  -v "$DATA_VOLUME":/restore/data \
  -v "$(dirname "$ARCHIVE")":/src:ro \
  alpine:3 \
  sh -c "tar xzf /src/$(basename "$ARCHIVE") -C /restore --strip-components=1 backup"

if [[ "$PROMOTE" == "1" ]]; then
  log "Promoting newest VACUUM'd snapshot over data/garbanzo.db"
  docker run --rm -v "$DATA_VOLUME":/data alpine:3 sh -c '
    snap=$(ls -1t /data/backups/garbanzo-*.db 2>/dev/null | head -1)
    [ -n "$snap" ] || { echo "no snapshot found in data/backups/" >&2; exit 1; }
    cp "$snap" /data/garbanzo.db
    rm -f /data/garbanzo.db-wal /data/garbanzo.db-shm
    echo "promoted $snap"
  '
fi

log "Restore complete. Start the stack with: docker compose up -d"
