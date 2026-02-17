# Setup Examples
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


This guide provides reproducible setup commands for common Garbanzo use-cases.

## 1) Interactive onboarding (recommended for first run)

```bash
npm run setup
```

## 2) Preview-only dry run (no file writes)

```bash
npm run setup -- --non-interactive --dry-run \
  --platform=whatsapp \
  --deploy=docker \
  --providers=openrouter,openai \
  --provider-order=openai,openrouter \
  --profile=lightweight \
  --owner-jid=your_number@s.whatsapp.net
```

## 3) Events-heavy community preset

```bash
npm run setup -- --non-interactive \
  --platform=whatsapp \
  --deploy=docker \
  --providers=openrouter,anthropic,openai \
  --provider-order=openrouter,openai,anthropic \
  --profile=events \
  --features=weather,transit,events,venues,poll,summary,recommend,feedback \
  --owner-jid=your_number@s.whatsapp.net \
  --owner-name="Community Admin" \
  --group-id=120000000000000000@g.us \
  --group-name="Community Events"
```

## 4) D&D group preset

```bash
npm run setup -- --non-interactive \
  --platform=whatsapp \
  --deploy=docker \
  --providers=openai,openrouter \
  --provider-order=openai,openrouter \
  --profile=dnd \
  --features=dnd,roll,character,fun,summary,feedback \
  --owner-jid=your_number@s.whatsapp.net \
  --group-id=120000000000000000@g.us \
  --group-name="DND Night"
```

## 5) Import custom persona during setup

```bash
npm run setup -- --non-interactive \
  --platform=whatsapp \
  --providers=openrouter,openai \
  --provider-order=openrouter,openai \
  --profile=full \
  --persona-file=./my-persona.md \
  --owner-jid=your_number@s.whatsapp.net
```

## 6) Slack demo mode (local dev only)

```bash
npm run setup -- --non-interactive --dry-run \
  --platform=slack \
  --slack-demo=true \
  --providers=openai \
  --openai-key=$OPENAI_API_KEY \
  --owner-jid=your_number@s.whatsapp.net
```

## 7) After setup

Default deployment (Docker Compose):

```bash
docker compose up -d
docker compose logs -f garbanzo
curl http://127.0.0.1:3001/health
```

Deploy a specific release image tag (recommended):

```bash
APP_VERSION=0.1.8 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.8 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## 8) Postgres migration dry-run + verification

```bash
# 1) Initialize schema in Postgres
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:postgres:init

# 2) Migrate local sqlite data
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:sqlite:migrate:postgres

# 3) Verify table row counts match sqlite
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:sqlite:verify:postgres

# 4) Run backend parity tests against Postgres
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run test:postgres
```
