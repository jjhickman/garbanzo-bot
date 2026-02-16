# Security Audit — Garbanzo Infrastructure

**Date:** 2026-02-13
**Auditor:** Pre-build infrastructure assessment
**Host:** Terra (primary)

---

## 🔴 Critical Findings

### 1. API Keys in Plaintext Config Files

**Risk: HIGH** — Keys were historically stored in plaintext config files under a user home directory

| Key | File | Action Needed |
|-----|------|---------------|
| `ANTHROPIC_API_KEY` (sk-ant-oat01-...) | .env | Rotate after migration |
| `GOOGLE_API_KEY` (AIzaSy...) | .env + legacy config | Rotate |
| `NEWSAPI_KEY` | .env + legacy config | Rotate |
| `MBTA_API_KEY` | .env + legacy config | Rotate |
| `OPENAI_API_KEY` | .env | Rotate |
| `BRAVE_SEARCH_API_KEY` | .env | Rotate |
| `PUBSUB_VERIFICATION_TOKEN` | .env | Rotate |
| `CALENDAR_CHANNEL_TOKEN` | .env | Rotate |

**These keys have been visible to any agent with file read access for the entire lifetime of the prior stack.**

**Recommendation:** Rotate ALL keys once the new bot is live. Use `.env` only (gitignored), never commit keys to config files. For production, consider using a secrets manager or encrypted env files.

### 2. ✅ UFW Firewall Inactive — FIXED

~~Terra had no host firewall running.~~

Resolved: UFW enabled with deny-incoming default, allowing SSH + Tailscale (`100.64.0.0/10`) + LAN (`192.168.50.0/24`). 4 rules active.

### 3. ✅ Services Bound to 0.0.0.0 — FIXED

~~Ollama and legacy services were reachable from any device on the LAN.~~

Resolved: Ollama bound to `127.0.0.1`. All legacy auxiliary services were decommissioned (ports 8085, 8089, 8091, 8092, 18789, 18790 closed).

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

~~Legacy gateway and docs server were publicly accessible via Tailscale Funnel.~~

Resolved: `tailscale funnel off` — no serve config remains. Funnel can be re-enabled later if webhook ingress is needed.

### 5. ✅ Ollama Bound to All Interfaces — FIXED

~~Ollama was on `*:11434`, accessible from LAN and Tailscale mesh.~~

Resolved: Bound to `127.0.0.1` via systemd override (`/etc/systemd/system/ollama.service.d/override.conf`).

---

## ✅ Good Findings (Keep These)

| Item | Status |
|------|--------|
| Legacy assistant stack fully decommissioned (all services stopped + disabled) | ✅ Done |
| ChromaDB bound to localhost (8000) | ✅ Correct |
| ML services were bound to localhost (now stopped) | ✅ N/A |
| Whisper Docker bound to localhost (8090) | ✅ Correct |
| Tailscale mesh active across 5+ devices | ✅ Solid |
| SSH running (key auth recommended) | ✅ Normal |
| Credential files have 600 permissions | ✅ Correct |
| Docker containers use bridge networking | ✅ Reasonable |
| Encrypted backups to NAS | ✅ Good practice |

---

## Input Sanitization & Prompt Injection Protection

**Added:** 2026-02-14 — `src/middleware/sanitize.ts`

All incoming messages pass through a sanitization pipeline before processing:

| Layer | Protection | Action |
|-------|-----------|--------|
| Control character stripping | Null bytes, zero-width chars, RTL overrides | Silently stripped |
| Message length limit | 4096 characters max | Message rejected with friendly error |
| Prompt injection detection | 10+ patterns (e.g., "ignore previous instructions", "pretend to be", "system prompt") | Detected and defanged (quoted), logged as warning, NOT rejected (avoids false positives) |
| JID validation | Ensures sender/group IDs match WhatsApp format | Invalid JIDs rejected |

Prompt injection detection is deliberately non-blocking — flagged messages are still processed but with the injection text quoted/defanged to reduce effectiveness. This avoids false positives while still protecting against most social engineering attacks on the AI.

## Data Privacy Notes

| Table | PII Stored | Purpose | Retention |
|-------|-----------|---------|-----------|
| `messages` | Sender JID, message text | Conversation context for AI | Auto-pruned: 30-day TTL + daily vacuum |
| `moderation_log` | Sender JID, flagged text | Strike tracking | Indefinite |
| `feedback` | Sender JID, suggestion/bug text, voter JIDs (JSON array) | Feature requests & bug reports | Indefinite |
| `daily_stats` | None (aggregate counts only) | Usage metrics | Indefinite |
| `memory` | None (community facts only, no PII) | Long-term bot knowledge | Owner-managed (manual delete) |
| `member_profiles` | JID, display name, interests, groups active | Personalized recommendations | Opt-in; user can delete via `!profile delete` |

All data is stored locally in `data/garbanzo.db` (SQLite, WAL mode). No data is sent to external services except message text sent to AI APIs (cloud failover order configured by `AI_PROVIDER_ORDER`, plus local Ollama for simple queries) for response generation.

**Backups:** Automated nightly via `VACUUM INTO` to `data/backups/`, 7-day retention, pruned automatically. Backups are currently **unencrypted** local files — suitable for crash recovery but not for off-site storage. Future work: encrypt with `age`/GPG before syncing to NAS (see Phase 7.8 in ROADMAP.md).

---

## Automated Secret Scanning

**Added:** 2026-02-14 — powered by [gitleaks](https://github.com/gitleaks/gitleaks) (MIT, v8.30+)

Hardcoded secrets are detected and blocked at three enforcement points:

| Layer | Command | When it runs |
|-------|---------|-------------|
| Pre-commit hook | `gitleaks git --staged` | Every `git commit` (automatic) |
| npm check pipeline | `npm run audit:secrets` | Part of `npm run check` (manual, pre-push) |
| Standalone scan | `./scripts/audit-secrets.sh` | On-demand |

### What it detects (150+ built-in rules + custom)

- API keys: Anthropic (`sk-ant-`), OpenAI (`sk-`), Google (`AIzaSy`), Brave (`BSA`), OpenRouter (`sk-or-`), AWS (`AKIA`), Stripe, Slack, SendGrid, npm, etc.
- GitHub tokens: PATs (`github_pat_`), OAuth (`gho_`), server (`ghs_`), app (`ghp_`)
- Private keys: RSA, EC, DSA, OpenSSH, PGP
- Database connection strings with embedded passwords
- **Custom:** WhatsApp JIDs with real phone numbers (project-specific)

### Configuration

- **Config file:** `.gitleaks.toml` (project root)
- **Path allowlist:** `baileys_auth/`, `node_modules/`, `dist/`, `data/`, `.env`, `package-lock.json` — excluded from all scans
- **Per-file allowlists:** `config/groups.json`, `.env.example`, `docs/` — allowed to contain WhatsApp JIDs
- **Inline suppression:** Add `gitleaks:allow` as a comment on any line to suppress a false positive

### Setup

The pre-commit hook is installed automatically by `scripts/setup.sh`. For manual installation:

```bash
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

### If a secret is accidentally committed

1. Remove the secret from the file immediately
2. Rotate the compromised credential at its provider
3. Add the new credential to `.env` only
4. If already pushed, consider using `git filter-repo` or BFG Repo-Cleaner to remove from history

## Dependency Vulnerability Scanning

**Added:** 2026-02-16 — powered by `npm audit` (built-in)

- `npm run check` now includes `npm run audit:deps` (`npm audit --audit-level=high`)
- Goal: fail fast on high/critical CVEs without adding new tooling or services
- For ongoing automation, GitHub Dependabot alerts/updates are still recommended (separate from local checks)

## Container Image Vulnerability Scanning

**Added:** 2026-02-16 — powered by [Trivy](https://github.com/aquasecurity/trivy)

- Docker release workflow scans the published GHCR image for `CRITICAL,HIGH` vulnerabilities (OS + library)
- Scan is currently non-blocking (report-only) to avoid interrupting releases; report is attached as a workflow artifact

## Log Monitoring Helpers

**Added:** 2026-02-16 — lightweight, local-only scripts (no new deps)

- `npm run logs:scan -- <path>` parses Pino JSON logs and summarizes WARN/ERROR/FATAL counts + top messages
- `npm run logs:journal -- --unit garbanzo.service --since "24 hours ago"` prints recent systemd user logs (if `journalctl` exists)

## Runtime Hardening Updates

**Added:** 2026-02-14 (Phase 7.8 partial)

- Health endpoint (`/health`) now includes basic per-IP rate limiting to reduce abuse if accidentally exposed.
- Health status now includes nightly backup integrity metadata (latest backup path/age/size and SQLite integrity check result).
- Default deployment path is Docker Compose with non-root container runtime and persisted volumes for auth/database state.

## Credential Rotation Program

- A monthly reminder issue is created by `.github/workflows/credential-rotation-reminder.yml`.
- Use `npm run rotate:gh-secrets` to push freshly rotated provider keys from local env vars to GitHub Actions secrets.
- Keep provider key rotation and GitHub secret updates paired in the same maintenance window.

---

## Remediation Log

### Applied 2026-02-13

| # | Finding | Fix Applied | Verified |
|---|---------|-------------|----------|
| 2 | UFW inactive | `sudo ufw enable` — deny incoming, allow SSH + Tailscale (`100.64.0.0/10`) + LAN (`192.168.50.0/24`) | ✅ 4 rules active |
| 3 | Ollama on `0.0.0.0:11434` | Created `/etc/systemd/system/ollama.service.d/override.conf` with `OLLAMA_HOST=127.0.0.1`, restarted | ✅ `127.0.0.1:11434` |
| 4 | Tailscale Funnel exposing legacy services | `tailscale funnel off` — both `/` and `/docs` routes removed | ✅ No serve config |
| 5 | Port 18790 on `0.0.0.0` | Stopped + disabled legacy webhooks service via `systemctl --user` | ✅ Port closed |
| — | **Full legacy stack decommission** | All systemd services stopped + disabled (artifacts preserved out-of-band) | ✅ Zero processes, zero ports |

### Remaining — Manual Steps

1. **[ ] Rotate all API keys** — old keys may have been exposed to AI agents with file read access in legacy plaintext config files

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

   After rotating, add new keys to your `.env` **only**. Never put keys in JSON configs.

2. **[x] Create dedicated systemd service** for the new bot — `garbanzo.service` installed and running as systemd user service (completed 2026-02-13, Phase 1)
3. **[ ] Consider SSH key-only auth** — disable password auth in `/etc/ssh/sshd_config`
