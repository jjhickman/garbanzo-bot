# OpenClaw Archive Reference

> This file documents what's in `~/.openclaw/` for future reference.
> The directory is preserved as-is (not deleted) in case artifacts need to be consulted.

## What Was OpenClaw?

An AI agent platform that promised WhatsApp integration. Used from Feb 7–13, 2026.
**WhatsApp was never successfully connected.** The entire bot pipeline never processed a real message.

## What's Worth Referencing

| Artifact | Path | Why |
|----------|------|-----|
| Group IDs | `hooks/whatsapp-moderation.js` lines 25-34 | Already migrated to `garbanzo-bot/config/groups.json` |
| Moderation logic | `hooks/whatsapp-moderation.js` | Progressive enforcement pattern (warn→notify→ban) |
| Event detection regex | `hooks/whatsapp-event-enrichment.js` | Natural language event parsing patterns |
| TV discussion hook | `hooks/whatsapp-tv-discussion.js` | Show mention detection + cooldown logic |
| Welcome templates | `workspace/data/welcome-templates.json` | Icebreakers and group descriptions |
| Boston spots | `workspace/data/boston-spots.json` | Curated venue data |
| Community rules | `agents/moderator/workspace/` | Moderation policy (already migrated to PERSONA.md) |
| Weather skill | `workspace/skills/google-weather/` | Python weather helper |
| MBTA skill | `workspace/skills/mbta/` | Transit schedule scripts |
| D&D skill | `workspace/skills/dnd/` | Dice rolling + SRD lookup |
| Docker compose | `workspace/deployments/terra/docker-compose.yml` | Terra service definitions |
| Backup script | `workspace/scripts/backup.sh` | Encrypted backup to NAS |

## What Should NOT Be Referenced

- `openclaw.json` (917 lines of over-engineered config)
- 85+ shell scripts (most never ran with real users)
- 7-agent architecture (premature over-engineering)
- 16 cron jobs (most failed or were unnecessary)
- 88 zombie sandbox directories

## API Keys to Rotate

All keys in `~/.openclaw/.env` have been exposed to AI agents with file read access.
Rotate them before using in the new project. See `garbanzo-bot/docs/SECURITY.md`.

## Services to Stop

### Already Done (2026-02-13)

- ✅ Tailscale Funnel disabled (`tailscale funnel off`)
- ✅ `openclaw-webhooks.service` stopped and disabled (port 18790 closed)

### Still Running — 9 Services

These are user-level systemd services that start on boot. They consume ~1.7GB RAM collectively and serve no purpose without WhatsApp connected.

```bash
# Stop all OpenClaw services
systemctl --user stop \
  openclaw-gateway \
  openclaw-classifiers \
  openclaw-embeddings \
  openclaw-ml-features \
  openclaw-public-docs \
  openclaw-task-router \
  openclaw-voice-bridge \
  openclaw-mbta-sse \
  openclaw-mbta-forwarder

# Prevent them from restarting on boot
systemctl --user disable \
  openclaw-gateway \
  openclaw-classifiers \
  openclaw-embeddings \
  openclaw-ml-features \
  openclaw-public-docs \
  openclaw-task-router \
  openclaw-voice-bridge \
  openclaw-mbta-sse \
  openclaw-mbta-forwarder
```

| Service | Port | What It Does |
|---------|------|-------------|
| `openclaw-gateway` | 18789 | Main gateway process (~465MB) |
| `openclaw-classifiers` | 8091 | sklearn message classifier (~223MB) |
| `openclaw-embeddings` | 8089 | sentence-transformers embeddings (~965MB) |
| `openclaw-ml-features` | 8092 | ML features gateway (~80MB) |
| `openclaw-public-docs` | 8085 | Python docs server (~20MB) |
| `openclaw-task-router` | — | Task routing (~21MB) |
| `openclaw-voice-bridge` | — | Voice bridge (~22MB) |
| `openclaw-mbta-sse` | — | MBTA SSE alert stream |
| `openclaw-mbta-forwarder` | — | MBTA alert forwarder |

> **Note:** Don't delete `~/.openclaw/` yet — the artifacts listed above may be useful
> during Phase 2–3 development. Once those features are rebuilt, it can be archived or removed.
