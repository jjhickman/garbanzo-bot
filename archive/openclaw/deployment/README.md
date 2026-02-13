# Terra — Ollama Migration + NFS + ChromaDB RAG

**Machine:** Ryzen 7 7700X, 96GB RAM, RTX 4060 Ti 16GB  
**Purpose:** Migrate from llama.cpp to Ollama, mount NAS models, set up RAG pipeline  

---

## Overview

Four changes to Terra:

1. **Migrate to Ollama** — Replace llama.cpp with Ollama (GPU inference, OpenAI-compatible API, easier model management)
2. **NFS client** — Mount NAS model storage for shared model access
3. **Uptime Kuma monitors** — Add health checks to NAS monitoring dashboard
4. **ChromaDB RAG** — Knowledge base search for FAQ/docs

---

## Execution Order

```bash
cd ~/.openclaw/workspace

# Step 1: Install Ollama, import GPT-OSS 20B, pull models
bash deployments/terra/migrate-to-ollama.sh

# Step 2: Mount NAS models (after NAS setup is done)
bash deployments/terra/setup-nfs-client.sh

# Step 3: Start ChromaDB, create RAG pipeline, index docs
bash deployments/terra/setup-chromadb.sh

# Step 4: Import monitors into Uptime Kuma (manual, via UI)
# Open http://nas.local:3001 → Settings → Backup → Import
# Use: deployments/terra/uptime-kuma-monitors.json
```

---

## What Changes

### Before (llama.cpp)
- Manual model loading via `llama-server`
- Custom server flags (`--jinja`)
- systemd service: `openclaw-local-llm.service`
- Model at: `~/.openclaw/models/gpt-oss-20b-mxfp4.gguf`

### After (Ollama)
- Managed model registry (`ollama pull`, `ollama run`)
- OpenAI-compatible API at `http://localhost:11434/v1`
- Automatic GPU detection (CUDA)
- Ollama manages model loading/unloading automatically
- Same model imported as `gpt-oss-20b`

### What's preserved
- The original GGUF file stays at `~/.openclaw/models/` as backup
- Old systemd service can be disabled: `systemctl --user disable openclaw-local-llm`
- All other ML services unchanged (embeddings, classifiers, whisper)

---

## Files

| File | Purpose |
|------|---------|
| `migrate-to-ollama.sh` | Install Ollama, import GGUF, pull models |
| `setup-nfs-client.sh` | Mount NAS model storage via NFS |
| `setup-chromadb.sh` | ChromaDB Docker + RAG indexing pipeline |
| `docker-compose.yml` | ChromaDB container definition |
| `uptime-kuma-monitors.json` | Health check configs for Uptime Kuma |
| `README.md` | This guide |
