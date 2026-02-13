#!/bin/bash
# Automated Backup for OpenClaw
# Backs up critical files: config, credentials, workspace, agent data
# Created: 2026-02-09

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/.openclaw/backups}"
OPENCLAW_DIR="$HOME/.openclaw"
TIMESTAMP=$(date '+%Y-%m-%d_%H%M%S')
BACKUP_NAME="openclaw-backup-${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"
MAX_BACKUPS=7  # Keep last 7 backups

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')]${NC} $*"; }
err() { echo -e "${RED}[$(date '+%H:%M:%S')]${NC} $*"; }

# Create backup directory
mkdir -p "$BACKUP_PATH"

log "🔄 Starting OpenClaw backup → $BACKUP_PATH"

# 1. Configuration (most critical)
log "📋 Backing up configuration..."
cp "$OPENCLAW_DIR/openclaw.json" "$BACKUP_PATH/"
cp "$OPENCLAW_DIR/.env" "$BACKUP_PATH/"
log "  ✅ openclaw.json + .env"

# 2. Credentials (WhatsApp auth, etc.)
log "🔑 Backing up credentials..."
if [ -d "$OPENCLAW_DIR/credentials" ]; then
    cp -r "$OPENCLAW_DIR/credentials" "$BACKUP_PATH/"
    log "  ✅ credentials/"
else
    warn "  ⚠️  No credentials directory found"
fi

# 3. Agent workspace files (AGENTS.md, SOUL.md, etc.)
log "📝 Backing up workspace core files..."
mkdir -p "$BACKUP_PATH/workspace"
for f in AGENTS.md SOUL.md USER.md IDENTITY.md HEARTBEAT.md TOOLS.md README.md; do
    [ -f "$OPENCLAW_DIR/workspace/$f" ] && cp "$OPENCLAW_DIR/workspace/$f" "$BACKUP_PATH/workspace/"
done
log "  ✅ Core workspace files"

# 4. Config directory
if [ -d "$OPENCLAW_DIR/workspace/config" ]; then
    cp -r "$OPENCLAW_DIR/workspace/config" "$BACKUP_PATH/workspace/"
    log "  ✅ workspace/config/"
fi

# 5. Feature/optimization databases
log "📊 Backing up databases..."
mkdir -p "$BACKUP_PATH/workspace/features" "$BACKUP_PATH/workspace/optimizations" "$BACKUP_PATH/workspace/security"
for db in features/ideas.json features/approved.json features/rejected.json \
          optimizations/suggestions.json optimizations/approved.json optimizations/rejected.json \
          security/vulnerabilities.json; do
    [ -f "$OPENCLAW_DIR/workspace/$db" ] && cp "$OPENCLAW_DIR/workspace/$db" "$BACKUP_PATH/workspace/$db"
done
log "  ✅ Feature/optimization/security databases"

# 6. Memory files
if [ -d "$OPENCLAW_DIR/workspace/memory" ]; then
    cp -r "$OPENCLAW_DIR/workspace/memory" "$BACKUP_PATH/workspace/"
    log "  ✅ Memory files"
fi

# 7. Agent-specific workspaces (lightweight — just config/soul files)
log "🤖 Backing up agent configs..."
mkdir -p "$BACKUP_PATH/agents"
for agent_dir in "$OPENCLAW_DIR/agents"/*/; do
    agent_name=$(basename "$agent_dir")
    agent_backup="$BACKUP_PATH/agents/$agent_name"
    mkdir -p "$agent_backup"
    
    # Copy workspace .md files (if any)
    if [ -d "${agent_dir}workspace" ]; then
        mkdir -p "$agent_backup/workspace"
        find "${agent_dir}workspace" -maxdepth 1 -name "*.md" -exec cp {} "$agent_backup/workspace/" \; 2>/dev/null
    fi
done
log "  ✅ Agent workspace configs"

# 8. Cron job state
log "⏰ Backing up cron job configs..."
if [ -f "$OPENCLAW_DIR/workspace/optimizations/metrics/cron_jobs.json" ]; then
    mkdir -p "$BACKUP_PATH/workspace/optimizations/metrics"
    cp "$OPENCLAW_DIR/workspace/optimizations/metrics/cron_jobs.json" "$BACKUP_PATH/workspace/optimizations/metrics/"
fi
log "  ✅ Cron configs"

# 9. Compress and encrypt the backup
log "📦 Compressing backup..."
cd "$BACKUP_DIR"
AGE_PUBKEY_FILE="$HOME/.openclaw/workspace/config/backup-public.key"
if command -v age >/dev/null 2>&1 && [[ -f "$AGE_PUBKEY_FILE" ]]; then
    AGE_RECIPIENT=$(cat "$AGE_PUBKEY_FILE")
    tar -czf - "$BACKUP_NAME" | age -r "$AGE_RECIPIENT" -o "${BACKUP_NAME}.tar.gz.age"
    rm -rf "$BACKUP_PATH"
    BACKUP_FILE="${BACKUP_NAME}.tar.gz.age"
    BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
    log "  ✅ Compressed + encrypted: $BACKUP_FILE ($BACKUP_SIZE)"
else
    warn "⚠️  age not available or no public key — backup will NOT be encrypted"
    tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME"
    rm -rf "$BACKUP_PATH"
    BACKUP_FILE="${BACKUP_NAME}.tar.gz"
    BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
    log "  ✅ Compressed (UNENCRYPTED): $BACKUP_FILE ($BACKUP_SIZE)"
fi

# 10. Rotate old backups (keep last N)
log "🔄 Rotating old backups (keeping last $MAX_BACKUPS)..."
backup_count=$(ls -1 "$BACKUP_DIR"/openclaw-backup-*.tar.gz* 2>/dev/null | wc -l)
if [ "$backup_count" -gt "$MAX_BACKUPS" ]; then
    to_delete=$((backup_count - MAX_BACKUPS))
    ls -1t "$BACKUP_DIR"/openclaw-backup-*.tar.gz* | tail -n "$to_delete" | while read -r old; do
        rm "$old"
        log "  🗑️  Removed: $(basename "$old")"
    done
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 BACKUP COMPLETE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  File: ${BACKUP_DIR}/${BACKUP_FILE}"
echo "  Size: $BACKUP_SIZE"
echo "  Encrypted: $(command -v age >/dev/null 2>&1 && [[ -f "$AGE_PUBKEY_FILE" ]] && echo 'YES (age)' || echo 'NO')"
echo "  Backups stored: $(ls -1 "$BACKUP_DIR"/openclaw-backup-*.tar.gz* 2>/dev/null | wc -l)/$MAX_BACKUPS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Restore instructions
echo ""
echo "📌 To restore from this backup:"
if [[ "$BACKUP_FILE" == *.age ]]; then
echo "  # Decrypt first:"
echo "  age -d -i ~/.openclaw/credentials/backup/backup.key ${BACKUP_DIR}/${BACKUP_FILE} | tar xzf - -C /tmp/"
else
echo "  tar -xzf ${BACKUP_DIR}/${BACKUP_FILE} -C /tmp/"
fi
echo "  cp /tmp/${BACKUP_NAME}/openclaw.json ~/.openclaw/"
echo "  cp /tmp/${BACKUP_NAME}/.env ~/.openclaw/"
echo "  # Then restart: systemctl --user restart openclaw-gateway"
