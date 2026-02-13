# OpenClaw Archive Reference

> OpenClaw was fully decommissioned on 2026-02-13.
> Salvageable artifacts have been copied to `archive/openclaw/` in this repo.
> The original `~/.openclaw/` directory is preserved on disk but all services are stopped and disabled.

## What Was OpenClaw?

An AI agent platform that promised WhatsApp integration. Used from Feb 7–13, 2026.
**WhatsApp was never successfully connected.** The entire bot pipeline never processed a real message.

## Preserved Artifacts

All useful files have been copied to `archive/openclaw/` (84 files, ~596KB):

| Directory | Contents | Use Case |
|-----------|----------|----------|
| `archive/openclaw/hooks/` | 6 JS hooks (moderation, events, welcome, TV discussion, help) | Logic patterns for Phase 2–3 features |
| `archive/openclaw/data/` | 26 JSON files (boston spots, welcome templates, D&D, books, hobbies, etc.) | Curated community content |
| `archive/openclaw/skills/` | Source files from 9 skills (weather, MBTA, D&D, events, news, etc.) | API integration reference |
| `archive/openclaw/deployment/` | docker-compose.yml, setup scripts, uptime-kuma monitors | Infrastructure patterns |
| `archive/openclaw/scripts/` | backup.sh | Encrypted backup to NAS reference |

Key artifacts already migrated into the main project:
- Group IDs → `config/groups.json`
- Community rules → `docs/PERSONA.md`
- Admin contacts → `config/groups.json`

## What Was NOT Preserved

- `openclaw.json` (917 lines of over-engineered config)
- 85+ shell scripts (most never ran with real users)
- 7-agent architecture (premature over-engineering)
- 16 cron jobs (most failed or were unnecessary)
- 88 zombie sandbox directories
- Skills venvs/node_modules (~262MB of dependencies)
- Moderator workspace markdown docs (AI-generated documentation of imaginary features)

## Decommission Log — 2026-02-13

All OpenClaw services have been stopped, disabled, and will not restart on boot.

| Action | Status |
|--------|--------|
| Tailscale Funnel disabled | ✅ Done |
| `openclaw-webhooks.service` stopped + disabled | ✅ Done |
| `openclaw-gateway.service` stopped + disabled | ✅ Done |
| `openclaw-classifiers.service` stopped + disabled | ✅ Done |
| `openclaw-embeddings.service` stopped + disabled | ✅ Done |
| `openclaw-ml-features.service` stopped + disabled | ✅ Done |
| `openclaw-public-docs.service` stopped + disabled | ✅ Done |
| `openclaw-task-router.service` stopped + disabled | ✅ Done |
| `openclaw-voice-bridge.service` stopped + disabled | ✅ Done |
| `openclaw-mbta-sse.service` stopped + disabled | ✅ Done |
| `openclaw-mbta-forwarder.service` stopped + disabled | ✅ Done |
| Artifacts preserved to `archive/openclaw/` | ✅ Done |
| API key rotation | ⬜ Manual — see `docs/SECURITY.md` |

## Cleanup (Optional, Not Urgent)

`~/.openclaw/` (~500MB) remains on disk. It can be deleted once:
1. API keys have been rotated (see `docs/SECURITY.md`)
2. Phase 2–3 features are built and you're confident nothing else is needed

```bash
# When ready:
rm -rf ~/.openclaw
# Also remove the systemd unit files:
rm ~/.config/systemd/user/openclaw-*.service
systemctl --user daemon-reload
```
