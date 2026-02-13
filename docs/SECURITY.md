# Security Audit — Garbanzo Bot Infrastructure

**Date:** 2026-02-13
**Auditor:** Pre-build infrastructure assessment
**Host:** Terra (primary)

---

## 🔴 Critical Findings

### 1. API Keys in Plaintext Config Files

**Risk: HIGH** — Keys are exposed in `~/.openclaw/openclaw.json` and `~/.openclaw/.env`

| Key | File | Action Needed |
|-----|------|---------------|
| `ANTHROPIC_API_KEY` (sk-ant-oat01-...) | .env | Rotate after migration |
| `GOOGLE_API_KEY` (AIzaSy...) | .env + openclaw.json | Rotate |
| `NEWSAPI_KEY` | .env + openclaw.json | Rotate |
| `MBTA_API_KEY` | .env + openclaw.json | Rotate |
| `VETTLY_API_KEY` | .env | Rotate |
| `BRAVE_SEARCH_API_KEY` | .env | Rotate |
| `OPENCLAW_GATEWAY_TOKEN` | .env | ✅ Decommissioned — OpenClaw stopped |
| `PUBSUB_VERIFICATION_TOKEN` | .env | Rotate |
| `CALENDAR_CHANNEL_TOKEN` | .env | Rotate |

**These keys have been visible to any agent with file read access for the entire lifetime of the OpenClaw setup.**

**Recommendation:** Rotate ALL keys once the new bot is live. Use `.env` only (gitignored), never commit keys to config files. For production, consider using a secrets manager or encrypted env files.

### 2. UFW Firewall Inactive

```
Status: inactive
```

Terra has **no host firewall** running. While the router/NAT provides some protection, and Tailscale handles mesh security, any service bound to `0.0.0.0` is reachable from the LAN.

**Recommendation:**
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow from 100.64.0.0/10   # Tailscale
sudo ufw allow from 192.168.50.0/24  # LAN (if needed)
sudo ufw enable
```

### 3. Services Bound to 0.0.0.0 (LAN-Accessible)

These services are reachable from **any device on your LAN**:

| Port | Service | Risk |
|------|---------|------|
| 10200 | Piper TTS (Docker) | Low — no sensitive data |
| 10300 | Wyoming Whisper (Docker) | Low — no sensitive data |
| 10400 | OpenWakeWord (Docker) | Low — no sensitive data |
| 11434 | **Ollama** | **MEDIUM** — anyone on LAN can run inference |
| 8085 | Python docs server | Low |
| 18790 | **OpenClaw Node process** | **HIGH** — potential control plane access |
| 22 | SSH | Normal — password/key auth |
| 111 | rpcbind (NFS) | Low — no NFS exports on Terra |

**Recommendation:** Bind Ollama to localhost (`OLLAMA_HOST=127.0.0.1`). Tailscale handles cross-machine access securely. Stop the OpenClaw node process (port 18790) when migrating away.

---

## 🟡 Medium Findings

### 4. Tailscale Funnel Exposes Two Services Publicly

```
https://terra.tailaba7ac.ts.net (Funnel on)
├── /     → proxy http://127.0.0.1:18790  (OpenClaw gateway)
└── /docs → proxy http://127.0.0.1:8085   (docs server)
```

The OpenClaw gateway is **publicly accessible via Tailscale Funnel**. Anyone who discovers the URL can hit the gateway.

**Recommendation:** Disable Funnel until you need webhook ingress for the new bot:
```bash
tailscale funnel off
```

### 5. Ollama Bound to All Interfaces

Ollama listens on `*:11434` — accessible from LAN, Tailscale mesh, and (if Funnel were misconfigured) potentially the internet.

**Recommendation:**
```bash
# In /etc/systemd/system/ollama.service.d/override.conf
[Service]
Environment="OLLAMA_HOST=127.0.0.1"
```
Then use Tailscale serve for cross-machine Ollama access (encrypted, authenticated).

---

## ✅ Good Findings (Keep These)

| Item | Status |
|------|--------|
| OpenClaw fully decommissioned (all services stopped + disabled) | ✅ Done |
| ChromaDB bound to localhost (8000) | ✅ Correct |
| ML services were bound to localhost (now stopped with OpenClaw) | ✅ N/A |
| Whisper Docker bound to localhost (8090) | ✅ Correct |
| Tailscale mesh active across 5+ devices | ✅ Solid |
| SSH running (key auth recommended) | ✅ Normal |
| Credential files have 600 permissions | ✅ Correct |
| .openclaw directory has 700 permissions | ✅ Correct |
| Docker containers use bridge networking | ✅ Reasonable |
| Encrypted backups to NAS | ✅ Good practice |

---

## Remediation Log

### Applied 2026-02-13

| # | Finding | Fix Applied | Verified |
|---|---------|-------------|----------|
| 2 | UFW inactive | `sudo ufw enable` — deny incoming, allow SSH + Tailscale (`100.64.0.0/10`) + LAN (`192.168.50.0/24`) | ✅ 4 rules active |
| 3 | Ollama on `0.0.0.0:11434` | Created `/etc/systemd/system/ollama.service.d/override.conf` with `OLLAMA_HOST=127.0.0.1`, restarted | ✅ `127.0.0.1:11434` |
| 4 | Tailscale Funnel exposing OpenClaw | `tailscale funnel off` — both `/` and `/docs` routes removed | ✅ No serve config |
| 5 | Port 18790 on `0.0.0.0` | Stopped + disabled `openclaw-webhooks.service` via `systemctl --user` | ✅ Port closed |
| — | **Full OpenClaw decommission** | All 10 systemd services stopped + disabled, artifacts preserved to `archive/openclaw/` | ✅ Zero processes, zero ports |

### Remaining — Manual Steps

1. **[ ] Rotate all API keys** — old keys were exposed to AI agents with file read access in `~/.openclaw/.env` and `~/.openclaw/openclaw.json`

   | Key | Where to rotate |
   |-----|----------------|
   | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys |
   | `GOOGLE_API_KEY` | [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials |
   | `NEWSAPI_KEY` | [newsapi.org/account](https://newsapi.org/account) |
   | `MBTA_API_KEY` | [api-v3.mbta.com/portal](https://api-v3.mbta.com/portal) |
   | `VETTLY_API_KEY` | Vettly dashboard |
   | `BRAVE_SEARCH_API_KEY` | [api.search.brave.com/app/keys](https://api.search.brave.com/app/keys) |
   | `PUBSUB_VERIFICATION_TOKEN` | Regenerate — this was a self-generated token |
   | `CALENDAR_CHANNEL_TOKEN` | Regenerate — this was a self-generated token |

   After rotating, add new keys to `~/garbanzo-bot/.env` **only**. Never put keys in JSON configs.

2. **[ ] Create dedicated systemd service** for the new bot (Phase 1 task — see ROADMAP.md)
3. **[ ] Consider SSH key-only auth** — disable password auth in `/etc/ssh/sshd_config`
