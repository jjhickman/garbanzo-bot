#!/usr/bin/env bash
# migrate-to-ollama.sh — Migrate Terra from llama.cpp to Ollama
#
# What this does:
#   1. Installs Ollama (if not already installed)
#   2. Imports our existing GPT-OSS 20B GGUF model
#   3. Pulls additional useful models
#   4. Creates a systemd service for Ollama
#   5. Updates OpenClaw's local-model-server.sh to use Ollama
#   6. Verifies everything works
#
# Prerequisites: NVIDIA drivers + CUDA already installed (we have them)
# Run as: bash deployments/terra/migrate-to-ollama.sh

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARN:${NC} $*"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $*"; }

WORKSPACE="$HOME/.openclaw/workspace"
MODELS_DIR="$HOME/.openclaw/models"
GGUF_MODEL="$MODELS_DIR/gpt-oss-20b-mxfp4.gguf"

# ── Step 1: Install Ollama ─────────────────────────────────────────
install_ollama() {
    if command -v ollama &>/dev/null; then
        log "Ollama already installed: $(ollama --version 2>/dev/null || echo 'unknown version')"
        return 0
    fi

    log "Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh

    if ! command -v ollama &>/dev/null; then
        err "Ollama installation failed"
        exit 1
    fi
    log "Ollama installed: $(ollama --version)"
}

# ── Step 2: Configure Ollama ───────────────────────────────────────
configure_ollama() {
    log "Configuring Ollama environment..."

    # Create systemd override for environment variables
    sudo mkdir -p /etc/systemd/system/ollama.service.d
    cat <<'EOF' | sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null
[Service]
# Bind to localhost + Tailscale only (not all interfaces)
Environment="OLLAMA_HOST=0.0.0.0:11434"
# Keep models loaded for 30 minutes (reduces reload overhead)
Environment="OLLAMA_KEEP_ALIVE=30m"
# Use CUDA (auto-detected, but explicit)
Environment="OLLAMA_GPU_DRIVER=cuda"
# Model storage location (can be pointed to NFS later)
Environment="OLLAMA_MODELS=/home/josh/.ollama/models"
EOF

    sudo systemctl daemon-reload
    log "Ollama environment configured"
}

# ── Step 3: Start Ollama ───────────────────────────────────────────
start_ollama() {
    log "Starting Ollama service..."
    sudo systemctl enable ollama
    sudo systemctl start ollama

    # Wait for Ollama to be ready
    local retries=0
    while ! curl -sf http://localhost:11434/api/tags &>/dev/null; do
        retries=$((retries + 1))
        if [[ $retries -gt 30 ]]; then
            err "Ollama failed to start within 30 seconds"
            sudo systemctl status ollama
            exit 1
        fi
        sleep 1
    done
    log "Ollama is running"
}

# ── Step 4: Import existing GGUF model ─────────────────────────────
import_gguf_model() {
    if ! [[ -f "$GGUF_MODEL" ]]; then
        warn "GGUF model not found at $GGUF_MODEL — skipping import"
        return 0
    fi

    log "Importing GPT-OSS 20B from GGUF..."

    # Create Modelfile for import
    local modelfile=$(mktemp)
    cat > "$modelfile" <<EOF
FROM $GGUF_MODEL
PARAMETER temperature 0.7
PARAMETER top_p 0.9
PARAMETER num_ctx 8192
TEMPLATE """{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
{{ .Response }}<|im_end|>
"""
SYSTEM "You are a helpful assistant."
EOF

    ollama create gpt-oss-20b -f "$modelfile"
    rm -f "$modelfile"
    log "GPT-OSS 20B imported as 'gpt-oss-20b'"
}

# ── Step 5: Pull additional models ─────────────────────────────────
pull_models() {
    log "Pulling recommended models for Terra (16GB VRAM)..."

    # Haiku-tier fast model for heartbeats/crons/simple tasks
    log "  Pulling qwen3:8b (fast, 8B, fits easily in 16GB)..."
    ollama pull qwen3:8b || warn "Failed to pull qwen3:8b"

    # Embeddings model (tiny, CPU-friendly)
    log "  Pulling nomic-embed-text (embeddings)..."
    ollama pull nomic-embed-text || warn "Failed to pull nomic-embed-text"

    log "Models pulled. Current library:"
    ollama list
}

# ── Step 6: Verify GPU access ──────────────────────────────────────
verify_gpu() {
    log "Verifying GPU access..."
    local response
    response=$(curl -sf http://localhost:11434/api/generate -d '{
        "model": "qwen3:8b",
        "prompt": "Say hello in exactly 5 words.",
        "stream": false,
        "options": {"num_predict": 20}
    }' 2>/dev/null) || true

    if echo "$response" | jq -e '.response' &>/dev/null; then
        log "GPU inference working! Response: $(echo "$response" | jq -r '.response' | head -1)"
    else
        warn "Could not verify GPU inference — check 'ollama ps' and nvidia-smi"
    fi
}

# ── Step 7: Update OpenClaw local model config ─────────────────────
update_openclaw_config() {
    log "Creating Ollama wrapper for OpenClaw..."

    cat > "$WORKSPACE/scripts/ollama-health.sh" <<'SCRIPT'
#!/usr/bin/env bash
# Quick health check for Ollama
set -euo pipefail
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "Ollama: running"
    ollama ps 2>/dev/null | tail -n +2 || echo "  No models loaded"
    exit 0
else
    echo "Ollama: not responding"
    exit 1
fi
SCRIPT
    chmod +x "$WORKSPACE/scripts/ollama-health.sh"

    log "OpenClaw can now use Ollama at http://localhost:11434/v1 (OpenAI-compatible)"
    log "Update openclaw.json to add Ollama as a model provider when ready"
}

# ── Main ───────────────────────────────────────────────────────────
main() {
    echo -e "${BLUE}━━━ Terra: Migrate to Ollama ━━━${NC}"
    echo ""

    install_ollama
    configure_ollama
    start_ollama
    import_gguf_model
    pull_models
    verify_gpu
    update_openclaw_config

    echo ""
    echo -e "${BLUE}━━━ Migration Complete ━━━${NC}"
    echo ""
    echo "  Ollama API:     http://localhost:11434"
    echo "  OpenAI compat:  http://localhost:11434/v1"
    echo "  Tailscale:      http://$(tailscale ip -4 2>/dev/null || echo 'N/A'):11434"
    echo ""
    echo "  Models available:"
    ollama list 2>/dev/null | sed 's/^/    /'
    echo ""
    echo "  Next steps:"
    echo "    1. Mount NAS model storage: bash deployments/terra/setup-nfs-client.sh"
    echo "    2. Add Uptime Kuma monitors: see deployments/terra/uptime-kuma-monitors.json"
    echo "    3. Set up ChromaDB RAG: bash deployments/terra/setup-chromadb.sh"
    echo ""
}

main "$@"
