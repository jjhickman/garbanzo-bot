#!/usr/bin/env bash
# backup-to-nas.sh — Push Terra's encrypted backup to NAS
#
# Integrates with existing weekly backup (age-encrypted)
# Runs AFTER the local backup script completes
#
# Add to crontab: 0 3 * * 0 bash ~/.openclaw/workspace/deployments/terra/backup-to-nas.sh
# (Sunday 3 AM — after the 2 AM local backup)

set -euo pipefail

LOG="$HOME/.openclaw/workspace/reports/backup-nas.log"
NAS_HOST="nas.local"
NAS_TAILSCALE="100.89.15.22"
BACKUP_SOURCE="$HOME/.openclaw/backups"
NAS_DEST="/volume1/backups/openclaw"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== NAS Backup Push Starting ==="

# Find NAS
NAS_ADDR=""
if ping -c 1 -W 3 "$NAS_HOST" &>/dev/null; then
    NAS_ADDR="$NAS_HOST"
elif ping -c 1 -W 3 "$NAS_TAILSCALE" &>/dev/null; then
    NAS_ADDR="$NAS_TAILSCALE"
else
    log "ERROR: NAS unreachable at $NAS_HOST and $NAS_TAILSCALE"
    exit 1
fi
log "NAS found at $NAS_ADDR"

# Find latest local backup
LATEST=$(ls -td "$BACKUP_SOURCE"/openclaw-backup-* 2>/dev/null | head -1)
if [[ -z "$LATEST" ]]; then
    log "ERROR: No local backup found in $BACKUP_SOURCE"
    exit 1
fi
log "Syncing: $LATEST"

# Transfer to NAS via tar+ssh (rsync broken on UGOS due to custom wrappers)
BACKUP_NAME=$(basename "$LATEST")
log "Transferring $BACKUP_NAME to NAS..."
ssh -o ConnectTimeout=10 "josh@${NAS_ADDR}" "mkdir -p ${NAS_DEST}/${BACKUP_NAME}"
tar -cf - -C "$LATEST" . | ssh -o ConnectTimeout=10 "josh@${NAS_ADDR}" \
    "tar -xf - -C ${NAS_DEST}/${BACKUP_NAME}/" 2>&1 | tee -a "$LOG"

# Update latest symlink on NAS
ssh -o ConnectTimeout=10 "josh@${NAS_ADDR}" \
    "ln -sfn ${NAS_DEST}/${BACKUP_NAME} ${NAS_DEST}/latest" 2>/dev/null || true

# Trigger rotation on NAS
ssh -o ConnectTimeout=10 "josh@${NAS_ADDR}" \
    "bash ~/nas-deployment/backup-receiver.sh" 2>/dev/null || \
    log "WARN: Could not run rotation on NAS (non-fatal)"

log "Backup pushed to NAS successfully: $BACKUP_NAME"
log "=== NAS Backup Push Complete ==="
