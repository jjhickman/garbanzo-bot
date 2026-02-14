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
| `OPENAI_API_KEY` | .env | Rotate |
| `BRAVE_SEARCH_API_KEY` | .env | Rotate |
| `OPENCLAW_GATEWAY_TOKEN` | .env | ✅ Decommissioned — OpenClaw stopped |
| `PUBSUB_VERIFICATION_TOKEN` | .env | Rotate |
| `CALENDAR_CHANNEL_TOKEN` | .env | Rotate |

**These keys have been visible to any agent with file read access for the entire lifetime of the OpenClaw setup.**

**Recommendation:** Rotate ALL keys once the new bot is live. Use `.env` only (gitignored), never commit keys to config files. For production, consider using a secrets manager or encrypted env files.

### 2. ✅ UFW Firewall Inactive — FIXED

~~Terra had no host firewall running.~~

Resolved: UFW enabled with deny-incoming default, allowing SSH + Tailscale (`100.64.0.0/10`) + LAN (`192.168.50.0/24`). 4 rules active.

### 3. ✅ Services Bound to 0.0.0.0 — FIXED

~~Ollama and OpenClaw were reachable from any device on the LAN.~~

Resolved: Ollama bound to `127.0.0.1`. All OpenClaw services decommissioned (ports 8085, 8089, 8091, 8092, 18789, 18790 closed).

Remaining services on `0.0.0.0` (low risk, no sensitive data):

| Port | Service | Risk |
|------|---------|------|
| 10200 | Piper TTS (Docker) | Low |
| 10300 | Wyoming Whisper (Docker) | Low |
| 10400 | OpenWakeWord (Docker) | Low |
| 22 | SSH | Normal |

---

## 🟡 Medium Findings

### 4. ✅ Tailscale Funnel — DISABLED

~~OpenClaw gateway and docs server were publicly accessible via Tailscale Funnel.~~

Resolved: `tailscale funnel off` — no serve config remains. Funnel can be re-enabled later if webhook ingress is needed for the new bot.

### 5. ✅ Ollama Bound to All Interfaces — FIXED

~~Ollama was on `*:11434`, accessible from LAN and Tailscale mesh.~~

Resolved: Bound to `127.0.0.1` via systemd override (`/etc/systemd/system/ollama.service.d/override.conf`).

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
    | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
   | `BRAVE_SEARCH_API_KEY` | [api.search.brave.com/app/keys](https://api.search.brave.com/app/keys) |
   | `PUBSUB_VERIFICATION_TOKEN` | Regenerate — this was a self-generated token |
   | `CALENDAR_CHANNEL_TOKEN` | Regenerate — this was a self-generated token |

   After rotating, add new keys to `~/garbanzo-bot/.env` **only**. Never put keys in JSON configs.

2. **[ ] Create dedicated systemd service** for the new bot (Phase 1 task — see ROADMAP.md)
3. **[ ] Consider SSH key-only auth** — disable password auth in `/etc/ssh/sshd_config`
