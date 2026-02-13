# Infrastructure Reference

> Preserved from OpenClaw project. Describes the hardware and network available to Garbanzo Bot.

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
| Ollama | 11434 | all (needs fixing) | 98.8 tok/s, qwen3:8b default |
| ChromaDB | 8000 | localhost | RAG embeddings |
| Whisper STT | 8090 | localhost | Speech-to-text |
| Embeddings | 8089 | localhost | nomic-embed-text |
| Classifiers | 8091 | localhost | Content classification |
| ML Gateway | 8092 | localhost | Unified ML API |

## Network

- **Tailscale mesh VPN** connects all machines
- **Tailscale Funnel** available for public webhook ingress
- LAN: `192.168.50.0/24`
- NAS NFS: model storage at `/volume2/models/`
- Backups: encrypted (age) to NAS `/volume1/backups/`

## Ollama Model Routing

| Priority | Host | Model | Speed | Cost |
|----------|------|-------|-------|------|
| 1 | Terra | qwen3:8b | 98.8 tok/s | Free |
| 2 | MacBook | qwen3:30b-a3b | 55.3 tok/s | Free |
| 3 | Desktop | (on-demand) | TBD | Free |

## Known Quirks

- Terra: use `~/.openclaw/workspace/.venv/bin/python3` for ChromaDB (system Python 3.14 incompatible)
- MacBook: needs `caffeinate` daemon to prevent lid-close sleep
- NAS: `scp`/`rsync` broken on UGOS Pro — use `cat | ssh cat >` for transfers
- Desktop: dual-boot, not always-on
