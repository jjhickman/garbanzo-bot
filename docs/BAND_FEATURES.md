# Band Features

The band feature set runs on the Discord profile. The old band compose overlay
is gone; use the main `docker-compose.yml` profiles and `.env.discord`.

## Setup

```bash
cp .env.example .env
cp .env.discord.example .env.discord
cp config/discord-channels.example.json config/discord-channels.json
```

In `.env`:

```bash
COMPOSE_PROFILES=discord
```

Add shared provider, vector, and monitoring values in `.env`.

In `.env.discord`:

```bash
DISCORD_BOT_TOKEN=...
DISCORD_OWNER_ID=...
BAND_FEATURES_ENABLED=true
# Optional audio transcription for dropped clips:
# WHISPER_URL=http://<whisper-host>:<port>
# Optional separate vector collection:
# QDRANT_COLLECTION=remy_memory
```

Fill `config/discord-channels.json` with the channel and role IDs for the band
server before starting Docker. The compose file bind-mounts that path read-only,
so it must exist as a file before `docker compose up`.

Start:

```bash
docker compose up -d
docker compose logs -f discord
```

Health:

```bash
curl http://127.0.0.1:3002/health
```

Band commands remain gated by `BAND_FEATURES_ENABLED=true`. Shared provider,
monitoring, and vector settings inherit from `.env`; Discord app, channel, role,
band, and transcription settings live in `.env.discord`.
