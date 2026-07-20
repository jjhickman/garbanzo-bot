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
http://127.0.0.1:${WHATSAPP_HEALTH_PORT:-3001}/whatsapp/login?token=<token>
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
  ssh -L ${WHATSAPP_HEALTH_PORT:-3001}:127.0.0.1:${WHATSAPP_HEALTH_PORT:-3001} pi@garbanzo-host
  # then open http://127.0.0.1:${WHATSAPP_HEALTH_PORT:-3001}/whatsapp/login?token=<token> on your laptop
  ```
- *Direct network exposure:* set `HEALTH_BIND_HOST=0.0.0.0`. On startup the logs
  then print connectable `http://<LAN-IP>:${WHATSAPP_HEALTH_PORT:-3001}/whatsapp/login` URLs using the
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

## Telegram Support

Telegram runs on [grammY](https://grammy.dev/) over long polling. No inbound
webhook config is needed, which fits multi-platform deployments. Setup uses the official
BotFather:

1. Message [@BotFather](https://t.me/BotFather) and run `/newbot`; follow its
   prompts to create the bot, then copy the token it gives you.
2. Message @BotFather again, run `/setprivacy`, choose the bot, then choose
   **Disable**. This is the recommended setup: Telegram bots default to
   "privacy mode," which withholds plain-text messages (including
   `@mentions`) from the bot entirely. Disabling it lets the bot see every
   message in a group so it can apply `requireMention` itself, the same
   shape as Discord's Message Content intent plus `requireMention`. Privacy
   mode stays a valid, degraded, replies-and-commands-only fallback for
   operators who don't want to touch this setting.
3. Message [@userinfobot](https://t.me/userinfobot) from your own account to
   get your numeric Telegram user id (`TELEGRAM_OWNER_ID`).
4. Add the bot to a group, send a message, then read the chat id off
   @userinfobot (forward the group message to it) or from
   `https://api.telegram.org/bot<token>/getUpdates` (`"chat":{"id":...}`).
   Group ids are negative; supergroup/channel ids are negative with a `-100`
   prefix (e.g. `-1001234567890`).

For Docker Compose:

```bash
cp .env.example .env
cp .env.telegram.example .env.telegram
cp config/telegram-chats.example.json config/telegram-chats.json
# In .env: COMPOSE_PROFILES=telegram
# In .env.telegram: set TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID, and chat ids.
docker compose up -d
docker compose logs -f telegram
```

For native development:

```bash
# .env
MESSAGING_PLATFORM=telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_OWNER_ID=...

npm run dev
```

Chat allowlists live in `config/telegram-chats.json`, following the same
`{ name, enabled, requireMention, enabledFeatures }` shape as
`config/discord-channels.json`.

`TELEGRAM_CHAT_SCOPE` controls which chats the bot ingests, and its default
differs deliberately from WhatsApp's: it defaults to `configured` (only
chats enabled in `config/telegram-chats.json`). This differs from WhatsApp's
default of `all`: a WhatsApp number only joins groups the operator explicitly links; anyone can add a Telegram
bot to any group via its `@username`, so ingesting every group by default
would be unsafe. DMs are never gated by this setting.

The Docker service is `telegram`, and its health server uses
`${TELEGRAM_HEALTH_PORT:-3005}` in Compose. The other platform placeholders are
`${WHATSAPP_HEALTH_PORT:-3001}` for WhatsApp,
`${DISCORD_HEALTH_PORT:-3002}` for Discord, and
`${MATRIX_HEALTH_PORT:-3004}` for Matrix.

Voice notes are transcribed through the same Whisper/`WHISPER_URL` path used
by the other platforms. There is no separate transcription config.

The model is instructed to write the same WhatsApp-style markdown
(`*bold*`, `_italic_`, `~strike~`) used across every other platform prompt;
the Telegram adapter translates that into Telegram's MarkdownV2 at send
time, so persona and prompt authors never need Telegram-specific syntax.

## Matrix Support

Matrix runs on [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk)
against your homeserver's `/sync` long-polling endpoint. No inbound webhook
config is needed, the same shape as Telegram's long polling. Setup uses a bot
account on your homeserver rather than a central bot directory:

1. Register a normal user account for the bot on your homeserver (operator-run
   Synapse/Dendrite/Conduit, or `matrix.org`).
2. Get that account's access token: log into it with Element, then go to
   Settings -> Help & About -> Advanced -> Access Token. (Scripting an
   `m.login.password` exchange against `/_matrix/client/v3/login` works too,
   if you'd rather not paste a password into a client.)
3. Note your own Matrix user id (not the bot's) for `MATRIX_OWNER_ID`, e.g.
   `@you:example.org`.
4. Get the room id for each room the bot should join. In Element: Room
   Settings -> Advanced -> Internal room ID (looks like
   `!abcdefghijklmno:example.org`). You can also give the setup wizard a
   published alias (`#general:example.org`) and it resolves the alias to a
   room id for you at setup time.

For Docker Compose:

```bash
cp .env.example .env
cp .env.matrix.example .env.matrix
cp config/matrix-rooms.example.json config/matrix-rooms.json
# In .env: COMPOSE_PROFILES=matrix
# In .env.matrix: set MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, MATRIX_OWNER_ID, and room ids.
docker compose up -d
docker compose logs -f matrix
```

For native development:

```bash
# .env
MESSAGING_PLATFORM=matrix
MATRIX_HOMESERVER_URL=https://matrix.example.org
MATRIX_ACCESS_TOKEN=...
MATRIX_OWNER_ID=@you:example.org

npm run dev
```

Matrix requires Node.js 22+ at runtime (`matrix-bot-sdk` declares
`engines.node >=22`), above the project's general Node 20+ floor. This only
matters for the no-Docker/`npx` quickstart path — the published Docker image
already runs a Node version that satisfies it.

`matrix-bot-sdk` is an optional dependency because it pulls a native crypto
package with no arm64-musl build. The Docker image (any architecture) and an
npm install on x86-64 or arm64-glibc get a working Matrix adapter. On a
bare-metal arm64-musl host (for example Alpine on a Raspberry Pi), the npm
install skips Matrix rather than failing. The other platforms still install,
and starting Matrix there prints a clear message pointing you at the Docker
image. Encryption is unsupported everywhere regardless (invite the bot only
into unencrypted rooms).

Room bindings live in `config/matrix-rooms.json`, keyed by **room ID**, never
by alias:

```json
{
  "ownerId": "@owner:example.org",
  "rooms": {
    "!abcdefghijklmno:example.org": {
      "alias": "#general:example.org",
      "name": "general",
      "enabled": true,
      "requireMention": true
    }
  }
}
```

Aliases can be deleted or repointed to a different room by any room admin at
any time, so they are not a stable identifier. The setup wizard resolves an
alias to its room id once, at setup time, and writes the room id as the
config key. `alias` stays in the file purely as a human-readable label.

`MATRIX_CHAT_SCOPE` controls which rooms the bot ingests, and defaults to
`configured` (only rooms enabled in `config/matrix-rooms.json`), the same
default and the same rationale as Telegram: anyone who knows the bot's Matrix
user id can invite it to a room, so ingesting every room it's invited to by
default would be unsafe. DMs are never gated by this setting.

The Docker service is `matrix`, and its health server uses
`${MATRIX_HEALTH_PORT:-3004}` in Compose. The other platform placeholders are
`${WHATSAPP_HEALTH_PORT:-3001}` for WhatsApp,
`${DISCORD_HEALTH_PORT:-3002}` for Discord, and
`${TELEGRAM_HEALTH_PORT:-3005}` for Telegram.

**End-to-end encryption is not supported.** Element defaults new private
rooms to encrypted, but Garbanzo's Matrix client has no E2EE support: the
native crypto module it would need has no prebuilt binary for
`linux-arm64-musl`, the architecture the project's own production image
targets. Invite the bot only into unencrypted rooms. If the bot is invited
into an encrypted room, it joins but cannot see anything. It logs a warning
and sits blind rather than crashing or silently failing.

The sync token that lets the bot resume from where it left off after a
restart, instead of re-fetching full room state, is persisted at
`data/matrix-sync.json` inside the data volume (or `GARBANZO_HOME` on a
native install). Deleting it is harmless. The bot just runs a fresh initial
sync on next start, but that sync can be slow on an account joined to many
active rooms.

Audio messages are transcribed through the same Whisper/`WHISPER_URL` path
used by the other platforms. There is no separate transcription config.

The model is instructed to write the same WhatsApp-style markdown
(`*bold*`, `_italic_`, `~strike~`) used across every other platform prompt;
the Matrix adapter alone translates that into Matrix's HTML
`formatted_body`, so persona and prompt authors never need Matrix-specific
syntax.

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
SLACK_EVENTS_PORT=${DISCORD_HEALTH_PORT:-3002}

npm run dev
```

For local pipeline verification without a Slack app:

```bash
# .env
MESSAGING_PLATFORM=slack
SLACK_DEMO=true

npm run dev

# In another terminal
curl -s -X POST "http://127.0.0.1:${DISCORD_HEALTH_PORT:-3002}/demo/chat" \
  -H 'content-type: application/json' \
  -d '{"platform":"slack","text":"@garbanzo !help"}'
```

## Native Events (`!event`)

The `!event` command creates real calendar entries on platforms that have a
native event primitive. The owner can always use it; when
`BAND_FEATURES_ENABLED=true`, band members can too. Other senders get a
standard permission reply.

```text
!event <when> | <name> [| location]   create an event
!event list                           upcoming events in the chat
!event show <id>                      event details
!event move <id> <when>               reschedule
!event rename <id> <name>             rename
!event cancel <id>                    cancel
```

`<when>` accepts the same phrases as event reminders: `tomorrow 7pm`,
`friday 8pm`, `8/2 19:00`, and similar, up to 30 days out. Event names are
limited to 100 characters and locations to 1000 (Discord's caps, applied on
every platform). When `EVENT_REMINDERS_ENABLED=true`, creating an event
also records a standard text reminder that fires
`EVENT_REMINDER_LEAD_MINUTES` before the start; moving or cancelling the
event reschedules or cancels that reminder with it.

Platform notes:

- **Discord** creates a guild scheduled event (external type, so no voice
  channel is required). The bot needs the **Manage Events** permission in
  the server; without it the command replies with a permission error
  instead of creating anything. If no end time is given, Discord events
  default to two hours; if no location is given, the location shows `TBD`.
- **WhatsApp** sends a native event message in the group. WhatsApp offers
  no supported way for a linked client to edit an event message after
  sending, so `!event move` and `!event rename` send a corrected
  replacement event message, and `!event cancel` sends the event marked as
  cancelled. The earlier event message stays in the chat history; the bot
  tracks the latest message. Event sends go through the standard outbound
  safety layer, so a send can be held for manual release instead of going
  out immediately. A held send is not lost and does not need the command
  repeated: the bot records the event (or the move/rename/cancel) in its
  database right away, replies with the held job number, and the event
  message posts once you release it with `!whatsapp release <id>`.
  Re-running the command would create a second event, so don't.
- **Telegram, Matrix, and Slack** have no native event primitive yet; the
  command replies that events are not supported on those platforms.

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
