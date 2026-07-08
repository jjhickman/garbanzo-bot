# Setup Examples
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

These examples use the current setup wizard flags from `scripts/setup.mjs` and `scripts/setup-fields.mjs`. The wizard writes layered env files: shared values in `.env`, Discord values in `.env.discord`, and WhatsApp values in `.env.whatsapp`.

## 1. Discord Community Bot

Preview the files first:

```bash
npm run setup -- --non-interactive --dry-run \
  --platform=discord \
  --deploy=docker \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --discord-bot-token=test_discord_bot_token \
  --discord-owner-id=111111111111111111 \
  --discord-gateway-enabled=true \
  --profile=full \
  --monitoring=true
```

Write the env files when the preview looks right:

```bash
npm run setup -- --non-interactive \
  --platform=discord \
  --deploy=docker \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --discord-bot-token=$DISCORD_BOT_TOKEN \
  --discord-owner-id=$DISCORD_OWNER_ID \
  --discord-gateway-enabled=true \
  --profile=full \
  --monitoring=true
```

Then edit `config/discord-channels.json` from `config/discord-channels.example.json` and start the service:

```bash
docker compose up -d
docker compose logs -f discord
curl "http://127.0.0.1:${DISCORD_HEALTH_PORT:-3002}/health"
```

## 2. WhatsApp Community Bot

```bash
npm run setup -- --non-interactive \
  --platform=whatsapp \
  --deploy=docker \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --owner-jid=your_number@s.whatsapp.net \
  --whatsapp-login-mode=web \
  --profile=events \
  --features=weather,transit,events,venues,poll,summary,recommend,feedback \
  --group-id=120000000000000000@g.us \
  --group-name="Community Events" \
  --bot-name=garbanzo
```

The wizard writes `.env` and `.env.whatsapp` and can write `config/groups.json` from the group flags. Start the WhatsApp service and scan the browser login page or terminal QR flow according to `WHATSAPP_LOGIN_MODE`:

```bash
docker compose up -d
docker compose logs -f whatsapp
curl "http://127.0.0.1:${WHATSAPP_HEALTH_PORT:-3001}/health"
```

## 3. Discord Band Mode

Band mode runs on the Discord profile with `BAND_FEATURES_ENABLED=true`.

```bash
npm run setup -- --non-interactive \
  --platform=discord \
  --deploy=docker \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --discord-bot-token=$DISCORD_BOT_TOKEN \
  --discord-owner-id=$DISCORD_OWNER_ID \
  --discord-gateway-enabled=true \
  --band-features-enabled=true \
  --qdrant-collection=remy_memory \
  --write-discord-channels=true \
  --profile=full
```

Fill `config/discord-channels.json` with the real channel and role ids before starting:

```bash
docker compose up -d
docker compose logs -f discord
curl "http://127.0.0.1:${DISCORD_HEALTH_PORT:-3002}/health/ready"
```

## 4. Discord and WhatsApp with Monitoring

Run setup once per platform so each platform env file is generated:

```bash
npm run setup -- --non-interactive \
  --platform=discord \
  --deploy=docker \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --discord-bot-token=$DISCORD_BOT_TOKEN \
  --discord-owner-id=$DISCORD_OWNER_ID \
  --discord-gateway-enabled=true \
  --monitoring=true

npm run setup -- --non-interactive \
  --platform=whatsapp \
  --deploy=docker \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --owner-jid=your_number@s.whatsapp.net \
  --whatsapp-login-mode=web \
  --profile=full
```

Set both platform profiles in `.env`:

```bash
COMPOSE_PROFILES=discord,whatsapp,monitoring
METRICS_ENABLED=true
MONITORING_TOKEN=replace_with_a_generated_secret
APP_VERSION=3.1.0
```

Start and inspect both services:

```bash
APP_VERSION=3.1.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull discord whatsapp
APP_VERSION=3.1.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

docker compose logs -f discord
docker compose logs -f whatsapp

curl "http://127.0.0.1:${DISCORD_HEALTH_PORT:-3002}/health"
curl "http://127.0.0.1:${WHATSAPP_HEALTH_PORT:-3001}/health"
```

## 5. Discord Community Bot (No Docker)

Preview the files first:

```bash
npm run setup -- --non-interactive --dry-run \
  --platform=discord \
  --deploy=native \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --discord-bot-token=test_discord_bot_token \
  --discord-client-id=222222222222222222 \
  --discord-owner-id=111111111111111111 \
  --discord-channel-id=333333333333333333
```

Write the files when the preview looks right, then build and start:

```bash
npm run setup -- --non-interactive \
  --platform=discord \
  --deploy=native \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --discord-bot-token=$DISCORD_BOT_TOKEN \
  --discord-client-id=$DISCORD_CLIENT_ID \
  --discord-owner-id=$DISCORD_OWNER_ID \
  --discord-channel-id=$DISCORD_CHANNEL_ID

npm run build && npm start
curl "http://127.0.0.1:${DISCORD_HEALTH_PORT:-3002}/health"
```

The native deploy target skips Docker-only prompts (monitoring,
`COMPOSE_PROFILES`) and defaults to `VECTOR_STORE=none` (keyword-only
memory). See [QUICKSTART.md](QUICKSTART.md) for the full no-Docker
walkthrough, including running as a service.

## Postgres Migration Dry Run

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:postgres:init
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:sqlite:migrate:postgres
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:sqlite:verify:postgres
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run test:postgres
```
