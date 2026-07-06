# Platforms & Login

## Local Development (without Docker)

```bash
npm install
cp .env.example .env
# Optional platform layer:
# cp .env.discord.example .env.discord
# cp .env.whatsapp.example .env.whatsapp
# Edit shared and platform env files, then edit the matching config file.
npm run dev

# Complete platform linking/auth when prompted.
# Discord is the default platform; WhatsApp links through a browser page by default.
```

## Discord Support

Discord is the default platform and uses the official Discord Gateway API. The
runtime reads and replies in opt-in channels, welcomes members, and posts
scheduled digests, recaps, event reminders, and band reminders from the Discord
runtime.

For Docker Compose:

```bash
cp .env.example .env
cp .env.discord.example .env.discord
cp config/discord-channels.example.json config/discord-channels.json
# In .env: COMPOSE_PROFILES=discord
# In .env.discord: set DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, and channel ids.
docker compose up -d
docker compose logs -f discord
```

For native development:

```bash
# .env
MESSAGING_PLATFORM=discord
DISCORD_BOT_TOKEN=...
DISCORD_OWNER_ID=...
DISCORD_GATEWAY_ENABLED=true

npm run dev
```

Channel allowlists, digest channels, recap channels, practice channels, and band
roles live in `config/discord-channels.json`.

## WhatsApp Login (Browser)

WhatsApp is fully supported through Baileys, an unofficial WhatsApp Web API.
Using it can carry account risk, so keep the outbound safety layer enabled and
avoid high-volume sends on new accounts.

By default (`WHATSAPP_LOGIN_MODE=web`) WhatsApp links through a small, token-gated
page on the health server instead of the terminal. On startup the logs print a URL
like:

```
http://127.0.0.1:3001/whatsapp/login?token=<token>
```

Open it (over an SSH tunnel or on the host) and either:

- **Scan QR** — the page shows a live QR that refreshes on its own; scan it from
  WhatsApp > Settings > Linked Devices. QR rotation within one attempt is normal and
  does not risk a bot-flag.
- **Pair with code** — enter the bot's phone number to get an 8-character code, then
  use WhatsApp > Linked Devices > "Link with phone number."

The page shows "Linked ✓" once connected.

- `WHATSAPP_LOGIN_MODE=terminal` restores the old in-terminal QR; `both` prints both.
- The login token is generated per run and printed once. Set `WHATSAPP_LOGIN_TOKEN`
  to pin it (e.g. for scripted access); an operator-set token is never echoed to the
  logs. This token only gates the WhatsApp browser-login page.
- All login routes are bound to `HEALTH_BIND_HOST` (`127.0.0.1` by default).

**Linking a remote/headless host (e.g. a Raspberry Pi over the network).** Two options:

- *SSH tunnel (recommended, keeps the default localhost bind):*
  ```bash
  ssh -L 3001:127.0.0.1:3001 pi@garbanzo-host
  # then open http://127.0.0.1:3001/whatsapp/login?token=<token> on your laptop
  ```
- *Direct network exposure:* set `HEALTH_BIND_HOST=0.0.0.0`. On startup the logs
  then print connectable `http://<LAN-IP>:3001/whatsapp/login` URLs using the
  machine's actual LAN address. This exposes the linking page to your whole network,
  guarded only by the login token over plaintext HTTP, so only do it on a trusted
  LAN. The bot logs a warning when
  login is bound to a non-loopback host.

For Docker Compose:

```bash
cp .env.example .env
cp .env.whatsapp.example .env.whatsapp
# In .env: COMPOSE_PROFILES=whatsapp
# In .env.whatsapp: set OWNER_JID and WhatsApp settings.
docker compose up -d
docker compose logs -f whatsapp
```

## Slack Support

For official Slack runtime:

```bash
# .env
MESSAGING_PLATFORM=slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_REFRESH_TOKEN=...
SLACK_EVENTS_BIND_HOST=0.0.0.0
SLACK_EVENTS_PORT=3002

npm run dev
```

For local pipeline verification without a Slack app:

```bash
# .env
MESSAGING_PLATFORM=slack
SLACK_DEMO=true

npm run dev

# In another terminal
curl -s -X POST http://127.0.0.1:3002/demo/chat \
  -H 'content-type: application/json' \
  -d '{"platform":"slack","text":"@garbanzo !help"}'
```

## Automated / Non-Interactive Setup

Use non-interactive mode for reproducible setup in scripts or CI-like environments:

```bash
npm run setup -- --non-interactive \
  --platform=discord \
  --deploy=docker \
  --providers=openrouter,openai \
  --provider-order=openai,openrouter \
  --profile=events \
  --features=weather,transit,events,venues,poll,summary \
  --owner-name="Your Name" \
  --persona-file=./my-persona.md
```

Get flag help:

```bash
npm run setup -- --help
```

Preview changes without writing files:

```bash
npm run setup -- --non-interactive --dry-run --platform=discord --providers=openai --profile=lightweight
```

More recipes: [`docs/SETUP_EXAMPLES.md`](SETUP_EXAMPLES.md)
