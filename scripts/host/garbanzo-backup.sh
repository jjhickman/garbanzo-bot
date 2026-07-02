#!/usr/bin/env bash
# garbanzo-backup.sh — archive the garbanzo Docker volumes to an external disk.
#
# Captures, in one dated tar.gz:
#   - auth/  : Baileys WhatsApp credentials (garbanzo-bot-auth volume)
#   - data/  : SQLite DB + the app's nightly VACUUM'd snapshots in data/backups/,
#              antiban state, etc. (garbanzo-bot-data volume)
#
# Before archiving, a fresh WAL-consistent DB snapshot (VACUUM INTO) is taken
# through the running container, so the archive always contains a restorable
# database even if the live garbanzo.db/-wal pair was mid-write.
#
# Environment (all optional):
#   BACKUP_DEST     destination directory   (default /media/josh/T9/garbanzo-backups)
#   AUTH_VOLUME     auth volume name        (default garbanzo-bot-auth)
#   DATA_VOLUME     data volume name        (default garbanzo-bot-data)
#   CONTAINER_NAME  running container name  (default garbanzo)
#   KEEP_DAILY      recent archives to keep (default 30)
#   KEEP_MONTHLY    months for which the first archive of the month is kept (default 12)
#   INCLUDE_VOICES  set to 1 to include data/voices (Piper models, re-downloadable; default excluded)
#   ALLOW_ROOT_FS   set to 1 to allow a destination on the root filesystem
#
# Exit codes: 0 ok; 1 configuration/environment error; 2 backup or verify failed.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/host/garbanzo-backup.sh [--help]

Archives the garbanzo Docker volumes (WhatsApp auth + data/SQLite) to
BACKUP_DEST (default /media/josh/T9/garbanzo-backups) with verification
and retention pruning. Designed to run nightly from a systemd timer —
see scripts/host/backup-install.sh and docs/BACKUPS.md.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

BACKUP_DEST="${BACKUP_DEST:-/media/josh/T9/garbanzo-backups}"
AUTH_VOLUME="${AUTH_VOLUME:-garbanzo-bot-auth}"
DATA_VOLUME="${DATA_VOLUME:-garbanzo-bot-data}"
CONTAINER_NAME="${CONTAINER_NAME:-garbanzo}"
KEEP_DAILY="${KEEP_DAILY:-30}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"
INCLUDE_VOICES="${INCLUDE_VOICES:-0}"
ALLOW_ROOT_FS="${ALLOW_ROOT_FS:-0}"

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
die() { log "ERROR: $*" >&2; exit "${2:-1}"; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"

# ── Destination sanity: refuse to "back up" onto the SD/NVMe root by accident ──
mkdir -p "$BACKUP_DEST" 2>/dev/null || die "cannot create $BACKUP_DEST — is the backup disk mounted?"
DEST_MOUNT="$(findmnt -no TARGET -T "$BACKUP_DEST" 2>/dev/null || echo '/')"
if [[ "$DEST_MOUNT" == "/" && "$ALLOW_ROOT_FS" != "1" ]]; then
  case "$BACKUP_DEST" in
    /media/*|/mnt/*)
      die "$BACKUP_DEST resolves to the root filesystem — the external disk is not mounted. Mount it (see docs/BACKUPS.md) or set ALLOW_ROOT_FS=1 to override." ;;
    *)
      die "BACKUP_DEST is on the root filesystem. Point it at the external disk or set ALLOW_ROOT_FS=1 to override." ;;
  esac
fi

docker volume inspect "$AUTH_VOLUME" >/dev/null 2>&1 || die "volume $AUTH_VOLUME not found"
docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1 || die "volume $DATA_VOLUME not found"

STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="garbanzo-backup-${STAMP}.tar.gz"

# ── Fresh WAL-consistent DB snapshot through the running app container ──
# VACUUM INTO refuses to overwrite, so clear the previous pre-backup snapshot first.
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  log "Taking consistent DB snapshot via $CONTAINER_NAME"
  docker exec "$CONTAINER_NAME" sh -c 'rm -f /app/data/backups/garbanzo-prebackup.db' || true
  if docker exec "$CONTAINER_NAME" node -e "
    const Database = require('better-sqlite3');
    const db = new Database('/app/data/garbanzo.db', { readonly: true });
    db.exec(\"VACUUM INTO '/app/data/backups/garbanzo-prebackup.db'\");
    db.close();
  "; then
    log "DB snapshot written to data/backups/garbanzo-prebackup.db"
  else
    log "WARN: live DB snapshot failed; relying on the app's nightly snapshots in data/backups/"
  fi
else
  log "Container $CONTAINER_NAME not running — volumes are cold and already consistent"
fi

# ── Archive both volumes read-only via a throwaway container ──
TAR_EXCLUDES=()
if [[ "$INCLUDE_VOICES" != "1" ]]; then
  TAR_EXCLUDES+=(--exclude 'backup/data/voices')
fi

log "Writing $BACKUP_DEST/$ARCHIVE"
docker run --rm \
  -v "$AUTH_VOLUME":/backup/auth:ro \
  -v "$DATA_VOLUME":/backup/data:ro \
  -v "$BACKUP_DEST":/dest \
  alpine:3 \
  tar czf "/dest/$ARCHIVE" "${TAR_EXCLUDES[@]}" backup \
  || die "archive creation failed" 2

# ── Verify ──
log "Verifying archive"
gzip -t "$BACKUP_DEST/$ARCHIVE" || die "gzip integrity check failed for $ARCHIVE" 2
LISTING="$(tar -tzf "$BACKUP_DEST/$ARCHIVE")"
echo "$LISTING" | grep -q 'backup/data/garbanzo.db' \
  || die "archive is missing the SQLite database" 2
if ! echo "$LISTING" | grep -q 'backup/auth/creds.json'; then
  log "WARN: archive has no WhatsApp creds.json (bot not linked yet?)"
fi
(cd "$BACKUP_DEST" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")

SIZE="$(du -h "$BACKUP_DEST/$ARCHIVE" | cut -f1)"
log "Archive OK: $ARCHIVE ($SIZE)"

# ── Retention: keep KEEP_DAILY most-recent; additionally keep the first archive
#    of each month for KEEP_MONTHLY months. Everything else is pruned. ──
mapfile -t ALL < <(cd "$BACKUP_DEST" && ls -1 garbanzo-backup-*.tar.gz 2>/dev/null | sort)
declare -A MONTH_FIRST=()
for f in "${ALL[@]}"; do
  month="${f#garbanzo-backup-}"; month="${month:0:6}"
  [[ -z "${MONTH_FIRST[$month]:-}" ]] && MONTH_FIRST[$month]="$f"
done
mapfile -t KEEP_MONTHS < <(printf '%s\n' "${!MONTH_FIRST[@]}" | sort -r | head -n "$KEEP_MONTHLY")

total="${#ALL[@]}"
pruned=0
for idx in "${!ALL[@]}"; do
  f="${ALL[$idx]}"
  # Most recent KEEP_DAILY archives always survive.
  (( idx >= total - KEEP_DAILY )) && continue
  month="${f#garbanzo-backup-}"; month="${month:0:6}"
  keep_as_monthly=0
  for m in "${KEEP_MONTHS[@]}"; do
    [[ "$m" == "$month" && "${MONTH_FIRST[$month]}" == "$f" ]] && keep_as_monthly=1
  done
  (( keep_as_monthly )) && continue
  rm -f "$BACKUP_DEST/$f" "$BACKUP_DEST/$f.sha256"
  log "Pruned $f"
  (( ++pruned ))
done

log "Done: $((total - pruned)) archive(s) retained at $BACKUP_DEST"
