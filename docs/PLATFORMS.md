# Platforms & Login

## Local Development (without Docker)

```bash
npm install
cp .env.example .env
# Edit .env and config/groups.json
npm run dev

# Complete platform linking/auth when prompted.
# WhatsApp links through a browser page by default — see "WhatsApp Login (Browser)" below.
```

## WhatsApp Login (Browser)

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
  logs. The same token also guards `/metrics`, so add `?token=<token>` when scraping.
- All login routes are bound to `HEALTH_BIND_HOST` (`127.0.0.1` by default).

**Linking a remote/headless host (e.g. a Raspberry Pi over the network).** Two options:

- *SSH tunnel (recommended, keeps the default localhost bind):*
  ```bash
  ssh -L 3001:127.0.0.1:3001 pi@garbanzo-host
  # then open http://127.0.0.1:3001/whatsapp/login?token=<token> on your laptop
  ```
- *Direct network exposure:* set `HEALTH_BIND_HOST=0.0.0.0`. On startup the logs
  then print connectable `http://<LAN-IP>:3001/whatsapp/login` URLs (the machine's
  LAN address, not `0.0.0.0`). This exposes the linking page — and `/health` +
  token-gated `/metrics` — to your whole network, guarded only by the login token
  over plaintext HTTP, so only do it on a trusted LAN. The bot logs a warning when
  login is bound to a non-loopback host.

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

## Discord Support

For official Discord runtime:

```bash
# .env
MESSAGING_PLATFORM=discord
DISCORD_BOT_TOKEN=...
DISCORD_PUBLIC_KEY=...
DISCORD_INTERACTIONS_BIND_HOST=0.0.0.0
DISCORD_INTERACTIONS_PORT=3003

npm run dev
```

For local pipeline verification without a Discord app setup:

```bash
# .env
MESSAGING_PLATFORM=discord
DISCORD_DEMO=true

npm run dev

# In another terminal
curl -s -X POST http://127.0.0.1:3003/discord/demo \
  -H 'content-type: application/json' \
  -d '{"chatId":"C123","senderId":"U123","text":"@garbanzo !help"}'
```

## Automated / Non-Interactive Setup

Use non-interactive mode for reproducible setup in scripts or CI-like environments:

```bash
npm run setup -- --non-interactive \
  --platform=whatsapp \
  --deploy=docker \
  --providers=openrouter,openai \
  --provider-order=openai,openrouter \
  --profile=events \
  --features=weather,transit,events,venues,poll,summary \
  --owner-jid=your_number@s.whatsapp.net \
  --owner-name="Your Name" \
  --group-id=120000000000000000@g.us \
  --group-name="General" \
  --persona-file=./my-persona.md
```

Get flag help:

```bash
npm run setup -- --help
```

Preview changes without writing files:

```bash
npm run setup -- --non-interactive --dry-run --platform=whatsapp --providers=openai --profile=lightweight
```

More recipes: [`docs/SETUP_EXAMPLES.md`](SETUP_EXAMPLES.md)

On first run, Baileys will display a QR code in the terminal. Scan it with WhatsApp (Settings > Linked Devices) to authenticate. Auth state persists in `baileys_auth/` across restarts.
