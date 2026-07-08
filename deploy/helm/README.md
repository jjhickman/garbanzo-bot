# Garbanzo Helm Chart

This chart is a Kubernetes distribution artifact for one Garbanzo bot instance.
Docker Compose remains the default deployment path for this project.

One Helm release equals one bot instance. Install the chart multiple times when
you run multiple instances, and give each release its own `instanceId`.

## Discord Example

```bash
helm install band-bot ./deploy/helm/garbanzo \
  --set platform=discord \
  --set instanceId=band-bot \
  --set secretEnv.DISCORD_BOT_TOKEN='<discord-token>' \
  --set secretEnv.DISCORD_OWNER_ID='<owner-id>' \
  --set secretEnv.OPENAI_API_KEY='<openai-key>'
```

Discord uses the chart default health port, matching `${DISCORD_HEALTH_PORT:-3002}` in Compose.

## WhatsApp Example

```bash
helm install community-wa ./deploy/helm/garbanzo \
  --set platform=whatsapp \
  --set instanceId=whatsapp-main \
  --set healthPort='${WHATSAPP_HEALTH_PORT:-3001}' \
  --set persistence.whatsappAuth.enabled=true \
  --set secretEnv.OWNER_JID='test_owner@s.whatsapp.net' \
  --set secretEnv.WHATSAPP_LOGIN_TOKEN='<login-token>' \
  --set secretEnv.OPENAI_API_KEY='<openai-key>'
```

WhatsApp needs the auth PVC at `/app/baileys_auth` so the linked-device session
survives pod restarts. After install, port-forward the service and open the
login page printed in `helm status`.

## Telegram Example

```bash
helm install community-tg ./deploy/helm/garbanzo \
  --set platform=telegram \
  --set instanceId=community-tg \
  --set healthPort='${TELEGRAM_HEALTH_PORT:-3005}' \
  --set secretEnv.TELEGRAM_BOT_TOKEN='<botfather-token>' \
  --set secretEnv.TELEGRAM_OWNER_ID='<owner-user-id>' \
  --set secretEnv.OPENAI_API_KEY='<openai-key>'
```

The chart default health port matches `${DISCORD_HEALTH_PORT:-3002}`. Telegram deployments should pass
`--set healthPort='${TELEGRAM_HEALTH_PORT:-3005}'` to match the compose and Prometheus convention. Set
`configFiles.telegramChatsJson` to mount a chart-managed
`config/telegram-chats.json`.

## Matrix Example

```bash
helm install community-mx ./deploy/helm/garbanzo \
  --set platform=matrix \
  --set instanceId=community-mx \
  --set healthPort='${MATRIX_HEALTH_PORT:-3004}' \
  --set secretEnv.MATRIX_ACCESS_TOKEN='<bot-access-token>' \
  --set env.MATRIX_HOMESERVER_URL='https://matrix.example.org' \
  --set env.MATRIX_OWNER_ID='@you:example.org' \
  --set secretEnv.OPENAI_API_KEY='<openai-key>'
```

As with Telegram, pass `--set healthPort='${MATRIX_HEALTH_PORT:-3004}'` explicitly. The chart default
matches `${DISCORD_HEALTH_PORT:-3002}`. Set `configFiles.matrixRoomsJson` to mount a chart-managed
`config/matrix-rooms.json`. The sync token lives in the data volume
(`data/matrix-sync.json`), so the default persistence covers it. Invite the
bot only into unencrypted rooms; E2EE is not supported.

## Multiple Instances

Install the chart once per instance:

```bash
helm install band-bot ./deploy/helm/garbanzo --set platform=discord,instanceId=band-bot
helm install boston-wa ./deploy/helm/garbanzo --set platform=whatsapp,instanceId=boston-wa,healthPort='${WHATSAPP_HEALTH_PORT:-3001}',persistence.whatsappAuth.enabled=true
helm install community-tg ./deploy/helm/garbanzo --set platform=telegram,instanceId=community-tg,healthPort='${TELEGRAM_HEALTH_PORT:-3005}'
helm install community-mx ./deploy/helm/garbanzo --set platform=matrix,instanceId=community-mx,healthPort='${MATRIX_HEALTH_PORT:-3004}'
```

This follows the `INSTANCE_ID` model used by bridging and shared memory. Keep
per-instance config and secrets isolated by release.

## Secrets

Use `secretEnv` for provider keys, bot tokens, owner ids, and login tokens when
you want Helm to create a Secret. Use `existingSecret` to reference a Secret you
manage outside Helm:

```bash
helm install band-bot ./deploy/helm/garbanzo \
  --set platform=discord \
  --set existingSecret=garbanzo-band-bot-env
```

Keys in either Secret are loaded through `envFrom`. Non-secret values belong in
`env`.

## Config Files

Set `configFiles.groupsJson`, `configFiles.discordChannelsJson`,
`configFiles.telegramChatsJson`, `configFiles.matrixRoomsJson`, or
`configFiles.bridgeMapJson` to mount chart-managed files under `/app/config`.
For larger files, prefer a values file:

```bash
helm install community-wa ./deploy/helm/garbanzo -f whatsapp-values.yaml
```

## Qdrant

Set `qdrant.enabled=true` to deploy a small in-chart Qdrant Deployment,
Service, and PVC. Set `qdrant.url` when you use an external Qdrant service.
