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

When ready to decommission OpenClaw:
```bash
# Stop the OpenClaw gateway (port 18789/18790)
# Find the process
ps aux | grep openclaw-gatewa
# Kill it
kill <pid>

# Disable Tailscale Funnel (currently exposing OpenClaw gateway publicly)
tailscale funnel off
```
