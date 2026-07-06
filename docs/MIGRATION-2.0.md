# Migration 2.0

Use this checklist for the v2 platform-first deployment model. Back up your old
shared and Remy env files first, then rebuild the new split layout in one pass.

## 1. Back Up Current Config

```bash
cp .env .env.pre-v2.backup
cp <old-remy-env-file> <old-remy-env-file>.pre-v2.backup
```

If one of those files does not exist on your host, skip that copy.

## 2. Stop Containers

```bash
docker compose down
```

Docker volumes persist. The `garbanzo-bot-auth` volume keeps the linked WhatsApp
session, so WhatsApp does not re-link and NOTHING re-links during this migration.
The existing data, Remy data, Qdrant, Prometheus, and Grafana volumes also keep
their contents.

## 3. Build The New Env Files

Create the shared layer:

```bash
cp .env.example .env
```

Set these in `.env`:

```bash
COMPOSE_PROFILES=discord,whatsapp,monitoring
MONITORING_TOKEN=<long-random-token>
METRICS_ENABLED=true
```

Move shared provider, vector, Ollama, persistence, and integration keys from the
old files into `.env`.

Create the Discord layer from the old Remy values:

```bash
cp .env.discord.example .env.discord
```

Move Discord-only values into `.env.discord`, including `DISCORD_BOT_TOKEN`,
`DISCORD_OWNER_ID`, band settings, channel config path, optional
`QDRANT_COLLECTION=remy_memory`, and optional `WHISPER_URL`. Do not duplicate
provider, vector, monitoring, or integration keys that now inherit from `.env`.

Create the WhatsApp layer:

```bash
cp .env.whatsapp.example .env.whatsapp
```

Move WhatsApp-only values into `.env.whatsapp`, including `OWNER_JID`,
`BOT_PHONE_NUMBER`, `WHATSAPP_LOGIN_MODE`, `WHATSAPP_LOGIN_TOKEN`, outbound
safety settings, and event-reminder settings.

## 4. Old To New Key Map

| Old key or location | New location | Notes |
|---|---|---|
| Old ops token role for `/metrics`, `/admin`, Prometheus, or Grafana | `MONITORING_TOKEN` in `.env` | Old monitoring/admin fallback behavior is gone. |
| `WHATSAPP_LOGIN_TOKEN` for WhatsApp browser login | `WHATSAPP_LOGIN_TOKEN` in `.env.whatsapp` | Keeps only the login-page role. |
| `OWNER_JID` | `.env.whatsapp` | Required only for `MESSAGING_PLATFORM=whatsapp`. |
| `MESSAGING_PLATFORM=discord` | Compose service pins it | Keep platform-specific values in `.env.discord`. |
| `MESSAGING_PLATFORM=whatsapp` | Compose service pins it | Keep platform-specific values in `.env.whatsapp`. |
| Provider keys and model settings | `.env` | Shared by every enabled platform instance. |
| `VECTOR_*`, `QDRANT_URL`, `QDRANT_API_KEY` | `.env` | Optional per-instance `QDRANT_COLLECTION` can stay in the platform layer. |
| `DISCORD_*` | `.env.discord` | Discord app, owner, channel, and gateway settings. |
| `BAND_FEATURES_ENABLED`, `WHISPER_URL` | `.env.discord` | Band mode runs on the Discord profile. |
| `BOT_PHONE_NUMBER`, `WHATSAPP_*`, `EVENT_REMINDER_*` | `.env.whatsapp` | WhatsApp-only runtime settings. |
| `APP_VERSION` | `.env` | Shared image pin for all compose services. |

## 5. Start V2

```bash
docker compose up -d
```

## 6. Verify

```bash
curl http://127.0.0.1:3002/health
curl http://127.0.0.1:3001/health
```

Open Grafana at `http://<host>:3000` and log in as `admin` with
`MONITORING_TOKEN` unless you set `GRAFANA_ADMIN_PASSWORD`.

In Prometheus at `http://127.0.0.1:9090/targets`, confirm both targets are `UP`:

- `discord` at `discord:3002`
- `whatsapp` at `whatsapp:3001`

Check logs for the persona startup lines:

```bash
docker compose logs discord | grep -i "online and listening"
docker compose logs whatsapp | grep -i "online and listening"
```
