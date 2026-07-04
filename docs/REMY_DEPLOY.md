# Remy Deploy

Run Remy beside the WhatsApp Garbanzo container with the compose overlay:

```bash
cp .env.remy.example .env.remy
# Fill in Discord and AI provider values, then:
docker compose -f docker-compose.yml -f docker-compose.remy.yml up -d
```

The overlay adds a second `remy` service that uses the same published Garbanzo image as the base `garbanzo` service, but runs with `MESSAGING_PLATFORM=discord`.

## Isolation

- Data is separate: Remy writes SQLite/runtime state to `remy_data:/app/data`, not `garbanzo_data`.
- Health is separate: Remy publishes `127.0.0.1:3002:3002`, leaving Garbanzo on `3001`.
- Vector memory is separate: Remy sets `QDRANT_COLLECTION=remy_memory`, leaving Garbanzo's `garbanzo_memory` collection untouched.
- Qdrant is shared: the overlay depends on the base `qdrant` service and does not redefine it.
- Discord config is separate: Remy mounts `./config/discord-channels.json` and should use a distinct Discord app/token from any other deployment.

Keep `.env.remy` local and gitignored. It should contain the real `DISCORD_BOT_TOKEN`, `DISCORD_OWNER_ID`, and one configured AI provider key.
