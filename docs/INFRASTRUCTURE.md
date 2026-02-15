# Infrastructure Reference

> Hardware and network available to Garbanzo.

## Fleet

| Machine | Specs | Tailscale IP | Role |
|---------|-------|-------------|------|
| **Terra** | Ryzen 7 7700X, 96 GB RAM, RTX 4060 Ti 16 GB, Ubuntu 24.04 | 100.102.168.128 | Primary host — runs the bot, Ollama, ML services |
| **MacBook Pro** | M2 Pro, 32 GB, macOS 15.6 | 100.103.40.102 | Secondary Ollama node (qwen3:30b-a3b, 55 tok/s) |
| **Desktop** | i9-14900K, RTX 5070 Ti 16 GB | 100.118.81.88 / 100.125.169.9 | On-demand ML training/inference |
| **NAS** | UGREEN DXP4800+, 64 GB RAM, 40+ TB | 100.89.15.22 | Backups, model storage (NFS) |
| **Pi 5** | BCM2712, 8 GB | 100.89.254.126 | Home Assistant (separate concern) |

## Terra Services (Bot Host)

| Service | Port | Binding | Notes |
|---------|------|---------|-------|
| **Garbanzo** | 3001 | localhost | Health check endpoint (`/health`) — JSON: connection status, uptime, memory, staleness, reconnect count, backup integrity status; includes basic per-IP rate limiting |
| Ollama | 11434 | localhost | 98.8 tok/s, qwen3:8b default |
| ChromaDB | 8000 | localhost | RAG embeddings |
| Whisper STT | 8090 | localhost | Speech-to-text (Docker) |
| Piper TTS | 10200 | 0.0.0.0 | Text-to-speech (Docker) |
| OpenWakeWord | 10400 | 0.0.0.0 | Wake word detection (Docker) |

> **Note:** All OpenClaw services (gateway, embeddings, classifiers, ML gateway, task-router,
> voice-bridge, MBTA SSE/forwarder, webhooks, public-docs) were decommissioned 2026-02-13.

## Network

- **Tailscale mesh VPN** connects all machines
- **Tailscale Funnel** disabled (was exposing OpenClaw; can be re-enabled for webhook ingress)
- LAN: `192.168.50.0/24`
- NAS NFS: model storage at `/volume2/models/`
- Backups: encrypted (age) to NAS `/volume1/backups/`

## Ollama Model Routing

| Priority | Host | Model | Speed | Cost |
|----------|------|-------|-------|------|
| 1 | Terra | qwen3:8b | 98.8 tok/s | Free |
| 2 | MacBook | qwen3:30b-a3b | 55.3 tok/s | Free |
| 3 | Desktop | (on-demand) | TBD | Free |

## Docker Support

The bot can also run as a Docker container for portable deployments:

- **Dockerfile** — multi-stage build (node:22-alpine), `dumb-init` for PID 1, non-root `garbanzo` user, ffmpeg + yt-dlp bundled, HEALTHCHECK on port 3001
- **docker-compose.yml** — named volumes for `baileys_auth` and `data`, env_file, 1 GB memory limit, log rotation, restart unless-stopped
- **Native deps** — `better-sqlite3` requires `python3 make g++` in the builder stage

```bash
# Build and run
docker compose up -d

# Check health
curl http://127.0.0.1:3001/health

# View logs
docker compose logs -f garbanzo
```

> **Note:** Docker Compose is the default deployment method. A systemd user service is still supported for native Node deployments.

## Known Quirks

- Terra: system Python is 3.14 — ChromaDB may need a dedicated venv (3.12 compatible)
- MacBook: needs `caffeinate` daemon to prevent lid-close sleep
- NAS: `scp`/`rsync` broken on UGOS Pro — use `cat | ssh cat >` for transfers
- Desktop: dual-boot, not always-on
