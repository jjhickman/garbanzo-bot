#!/usr/bin/env bash
# setup-nfs-client.sh — Mount NAS model storage on Terra via NFS
#
# Prerequisites:
#   - NAS setup complete (deployments/nas/setup-nas.sh ran on NAS)
#   - NFS exports configured on NAS for /volume2/models
#
# What this does:
#   1. Installs NFS client utilities
#   2. Creates local mount point
#   3. Tests NFS connectivity to NAS
#   4. Mounts the NAS model share
#   5. Adds to /etc/fstab for persistent mounting
#   6. Optionally configures Ollama to use NAS models directory

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARN:${NC} $*"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $*"; }

# NAS connection details — try LAN first, then Tailscale
NAS_HOST="nas.local"
NAS_TAILSCALE="100.89.15.22"
NAS_EXPORT="/volume2/models"
MOUNT_POINT="/mnt/nas-models"

# Also mount backup target for reference
BACKUP_EXPORT="/volume1/backups/openclaw"
BACKUP_MOUNT="/mnt/nas-backups"

# ── Step 1: Install NFS client ─────────────────────────────────────
install_nfs_client() {
    if command -v showmount &>/dev/null; then
        log "NFS client already installed"
        return 0
    fi
    log "Installing NFS client..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq nfs-common
    log "NFS client installed"
}

# ── Step 2: Resolve NAS address ────────────────────────────────────
resolve_nas() {
    # Try LAN first (faster)
    if ping -c 1 -W 2 "$NAS_HOST" &>/dev/null; then
        log "NAS reachable at $NAS_HOST (LAN)"
        NAS_ADDR="$NAS_HOST"
        return 0
    fi

    # Try Tailscale
    if ping -c 1 -W 2 "$NAS_TAILSCALE" &>/dev/null; then
        log "NAS reachable at $NAS_TAILSCALE (Tailscale)"
        NAS_ADDR="$NAS_TAILSCALE"
        return 0
    fi

    err "Cannot reach NAS at $NAS_HOST or $NAS_TAILSCALE"
    err "Ensure NAS is powered on and on the same network"
    exit 1
}

# ── Step 3: Verify NFS exports ─────────────────────────────────────
verify_exports() {
    log "Checking NFS exports on $NAS_ADDR..."
    local exports
    exports=$(showmount -e "$NAS_ADDR" 2>/dev/null) || {
        err "Cannot query NFS exports from $NAS_ADDR"
        err "Ensure NFS server is running on the NAS (run setup-nas.sh first)"
        exit 1
    }

    if echo "$exports" | grep -q "$NAS_EXPORT"; then
        log "Found export: $NAS_EXPORT"
    else
        warn "Export $NAS_EXPORT not found. Available exports:"
        echo "$exports" | sed 's/^/  /'
        err "Run setup-nas.sh on the NAS first to configure exports"
        exit 1
    fi
}

# ── Step 4: Mount model storage ────────────────────────────────────
mount_models() {
    sudo mkdir -p "$MOUNT_POINT"

    if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
        log "Models already mounted at $MOUNT_POINT"
        return 0
    fi

    log "Mounting $NAS_ADDR:$NAS_EXPORT at $MOUNT_POINT..."
    sudo mount -t nfs -o ro,soft,timeo=10,retrans=3 "$NAS_ADDR:$NAS_EXPORT" "$MOUNT_POINT"
    log "Models mounted successfully"

    # Show contents
    echo "  Contents:"
    ls -lh "$MOUNT_POINT" 2>/dev/null | head -10 | sed 's/^/    /'
}

# ── Step 5: Add to fstab ──────────────────────────────────────────
add_to_fstab() {
    local fstab_entry="$NAS_ADDR:$NAS_EXPORT $MOUNT_POINT nfs ro,soft,timeo=10,retrans=3,noauto,x-systemd.automount,x-systemd.idle-timeout=600 0 0"

    if grep -q "$MOUNT_POINT" /etc/fstab 2>/dev/null; then
        log "fstab entry already exists for $MOUNT_POINT"
        return 0
    fi

    log "Adding to /etc/fstab (automount on access, unmount after 10min idle)..."
    echo "$fstab_entry" | sudo tee -a /etc/fstab >/dev/null
    sudo systemctl daemon-reload
    log "fstab entry added"
}

# ── Step 6: Update backup script to push to NAS ───────────────────
update_backup_script() {
    local backup_script="$HOME/.openclaw/workspace/scripts/backup.sh"
    if [[ ! -f "$backup_script" ]]; then
        warn "Backup script not found at $backup_script"
        return 0
    fi

    # Check if NAS rsync is already configured
    if grep -q "nas.local\|nas-backups\|rsync.*nas" "$backup_script" 2>/dev/null; then
        log "Backup script already has NAS integration"
        return 0
    fi

    log "Adding NAS rsync push to backup script..."
    cat >> "$backup_script" <<'NASBACKUP'

# ── NAS Backup Push ───────────────────────────────────────────────
# Push latest backup to NAS for offsite redundancy
push_to_nas() {
    local NAS_HOST="nas.local"
    local NAS_BACKUP_DIR="/volume1/backups/openclaw"
    local LATEST_BACKUP=$(ls -td "$BACKUP_DIR"/openclaw-backup-* 2>/dev/null | head -1)

    if [[ -z "$LATEST_BACKUP" ]]; then
        warn "No backup found to push to NAS"
        return 0
    fi

    if ! ping -c 1 -W 2 "$NAS_HOST" &>/dev/null; then
        warn "NAS not reachable — skipping remote backup push"
        return 0
    fi

    log "Pushing backup to NAS..."
    rsync -az --delete "$LATEST_BACKUP/" "josh@${NAS_HOST}:${NAS_BACKUP_DIR}/latest/" 2>/dev/null && \
        log "Backup pushed to NAS successfully" || \
        warn "NAS backup push failed (non-fatal)"
}

# Run NAS push after local backup completes
push_to_nas
NASBACKUP

    log "NAS backup push added to backup script"
}

# ── Main ───────────────────────────────────────────────────────────
main() {
    echo -e "${BLUE}━━━ Terra: NFS Client Setup ━━━${NC}"
    echo ""

    install_nfs_client
    resolve_nas
    verify_exports
    mount_models
    add_to_fstab
    update_backup_script

    echo ""
    echo -e "${BLUE}━━━ NFS Setup Complete ━━━${NC}"
    echo ""
    echo "  Model storage: $MOUNT_POINT (read-only from NAS)"
    echo "  NAS address:   $NAS_ADDR"
    echo ""
    echo "  To copy a model to NAS (from Terra):"
    echo "    scp ~/.openclaw/models/model.gguf josh@nas.local:/volume2/models/"
    echo ""
    echo "  To use NAS models with Ollama, create a Modelfile pointing to $MOUNT_POINT/model.gguf"
    echo ""
}

main "$@"
