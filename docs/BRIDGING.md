# Cross-Platform Bridging

Bridging lets two or more Garbanzo instances (Discord, WhatsApp, or a mix)
share curated memory and relay chat messages between mapped channels/groups.
Every part of it is off by default. An existing single-instance deployment
that never touches these flags is unaffected.

Two independent tiers:

- **Tier 1 - shared memory.** The owner explicitly shares a curated fact
  (`!memory share <id>`) into a dedicated cross-instance vector collection.
  Nothing is shared automatically; conversation history and session summaries
  never leave the instance they were created on.
- **Tier 2 - message bridging.** Chat routes defined in
  `config/bridge-map.json` relay text between mapped channels/groups, with
  attribution (`Ana (Discord · practice): ...` when a configured chat name is
  available), through a durable per-instance outbox and a pluggable transport
  (HTTP or AMQP).

Bridge envelope schemas are strict. The current envelope includes optional
origin chat display names for better attribution, so bridged instances should
be upgraded together; a newer sender can produce envelopes that a v3.0.0 peer
rejects. Bridging is default-off, so existing deployments that have not
enabled it are unaffected.

## Flags summary

| Flag | Default | Purpose |
|------|---------|---------|
| `INSTANCE_ID` | unset (falls back to `MESSAGING_PLATFORM`) | Deployment identity used by bridge routes, shared-fact ids, and metrics |
| `BRIDGE_ENABLED` | `false` | Master switch for Tier 2 message bridging |
| `BRIDGE_TRANSPORT` | `http` | `http` or `amqp` |
| `BRIDGE_BROKER_URL` | unset | Required when `BRIDGE_TRANSPORT=amqp` |
| `BRIDGE_SUMMARY_INTERVAL_MINUTES` | `15` | How often the WhatsApp digest flusher runs |
| `BRIDGE_MAX_TEXT` | `1500` | Max characters per relayed/digest message |
| `SHARED_MEMORY_ENABLED` | `false` | Master switch for Tier 1 shared memory |
| `QDRANT_SHARED_COLLECTION` | `garbanzo_shared` | Qdrant collection used for shared facts |
| `QDRANT_COLLECTION` | `garbanzo_memory`, or `garbanzo_memory_<INSTANCE_ID>` when `INSTANCE_ID` is set and this is left unset | Local Qdrant collection for this instance's own facts (see [Local memory isolation](#local-memory-isolation)) |

Full descriptions and defaults: [docs/CONFIGURATION.md](CONFIGURATION.md).

## Local memory isolation

**Every instance needs its own local fact collection.** Bridging only shares
what the owner explicitly runs `!memory share <id>` on (Tier 1, above) — it
never shares raw local memory. But if two instances point at the same Qdrant
deployment and both fall back to the same collection name, every locally
indexed fact (session memory, auto-extracted facts, everything under plain
`!memory`) becomes visible to both instances, silently, with no share command
involved. That defeats isolation even when bridging itself is off.

`QDRANT_COLLECTION` defaults to `garbanzo_memory`. The moment you set
`INSTANCE_ID` for a deployment and leave `QDRANT_COLLECTION` unset, the
collection automatically becomes `garbanzo_memory_<INSTANCE_ID>` instead — so
running two or more instances with distinct `INSTANCE_ID`s against one Qdrant
server already gives each one an isolated local collection with no extra
config. A single-instance deployment that never sets `INSTANCE_ID` is
unaffected and keeps `garbanzo_memory`. An explicit `QDRANT_COLLECTION` always
wins over the derived name, for the rare case where you want to pin it
yourself.

The shared collection (`QDRANT_SHARED_COLLECTION`, Tier 1 above) is a
separate, deliberate exception to this isolation — the only path into it is
`!memory share`.

## Quick start (HTTP transport, two instances)

This is the simplest setup: two instances (for example a Discord instance
and a WhatsApp instance) on the same Docker Compose network, bridged over
plain HTTP with no extra containers.

1. **Set flags in each instance's env file.** `MONITORING_TOKEN` must be the
   **same value on both instances** — the HTTP transport authenticates
   bridge deliveries with it, the same token that already gates `/metrics`
   and `/admin`.

   In `.env` (shared by both instances) or split across `.env.discord` /
   `.env.whatsapp`:

   ```bash
   BRIDGE_ENABLED=true
   MONITORING_TOKEN=some-shared-secret
   # BRIDGE_TRANSPORT defaults to http, no need to set it
   ```

   Give each instance its own identity so bridge routes can address it:

   ```bash
   # in .env.discord
   INSTANCE_ID=discord-main
   # in .env.whatsapp
   INSTANCE_ID=whatsapp-main
   ```

   If you skip `INSTANCE_ID`, it defaults to `MESSAGING_PLATFORM` (`discord`
   or `whatsapp`), which is fine when you only ever run one instance per
   platform.

2. **Edit `config/bridge-map.json`.** Start from
   `config/bridge-map.example.json` and replace the ids, urls, and chat ids
   with your own. The committed `config/bridge-map.json` starts empty
   (`{"instances": [], "routes": []}`), which is intentionally inert: with
   `BRIDGE_ENABLED=true` and an empty map, the bridge starts but has nothing
   to relay.

   The schema has two top-level arrays:

   - **`instances`** - one entry per bridged deployment:
     - `id` - matches that instance's `INSTANCE_ID` (or its `MESSAGING_PLATFORM`
       if `INSTANCE_ID` is unset).
     - `platform` - one of `whatsapp`, `discord`, `slack`, `telegram`, `matrix`.
       Telegram and Matrix both have runtimes and can be bridged today.
     - `url` (optional) - the base URL the HTTP transport uses to reach that
       instance, for example `http://discord:${DISCORD_HEALTH_PORT:-3002}`,
       `http://whatsapp:${WHATSAPP_HEALTH_PORT:-3001}`,
       `http://telegram:${TELEGRAM_HEALTH_PORT:-3005}`, or
       `http://matrix:${MATRIX_HEALTH_PORT:-3004}` on the compose
       network. The bridge loader expands `${VAR}` and `${VAR:-default}`
       placeholders before validating the JSON. Not used by the AMQP
       transport.
   - **`routes`** - one entry per bridged conversation group:
     - `id` - a unique, human-readable route slug.
     - `endpoints` - two or more `{instance, chatId}` entries. `instance`
       must match a declared instance id; `chatId` is the channel/group/room
       id on that instance. A message from one endpoint fans out to every
       other endpoint in the route. Each instance may appear **at most once
       per route** — a bridge member is one distinct instance. If you need to
       bridge two chats on the same platform (for example two WhatsApp
       numbers), run a second instance with its own `INSTANCE_ID` and list
       both instances in the route, rather than one instance with two chat
       ids.
     - `direction` - `both` (relay from any member to all other members) or
       `one-way`. `one-way` requires `from`, set to one endpoint instance id;
       only messages from that instance fan out. This is not transitive:
       relayed messages are delivered as direct sends and are never
       re-captured as new inbound bridge messages.
     - `modeToWhatsApp` - `summary` (default) or `verbatim`. Governs how
       messages arriving *at* each WhatsApp endpoint are delivered.
     - `modeToDiscord` - `verbatim` (default) or `summary`. Same idea, for a
       Discord endpoint. In an N-ary group, mode is resolved by each
       destination platform, so a WhatsApp target can summarize while a
       Discord target receives the same source message verbatim. There is no
       `modeToTelegram` field: Telegram
       endpoints always relay directly (verbatim) — the summary buffer exists
       to fold messages behind WhatsApp's outbound-safety backpressure, which
       Telegram's official Bot API has no equivalent of. Instead, sends to a
       Telegram destination chat are proactively paced at least 3 seconds
       apart (per destination chat) so a burst of relays from a busy source
       can't systematically trip Telegram's per-chat rate limit; the
       Telegram adapter also retries a single 429 using the server's own
       `retry_after` on top of that spacing. There is likewise no
       `modeToMatrix` field: Matrix endpoints always relay directly
       (verbatim). Matrix bridge deliveries have no fixed pacing, unlike
       Telegram's proactive spacing — homeserver rate limits
       (`M_LIMIT_EXCEEDED`) are operator-configurable rather than a fixed
       vendor ceiling, so the Matrix adapter retries inline only for a short
       wait and defers anything longer through the same durable outbox used
       for held WhatsApp sends.
     - `relayCommands` - `false` by default. When false, messages starting
       with `!` (bang commands like `!weather`) are not relayed.
     - `ingestRelayed` - `false` by default. When true, successfully delivered
       verbatim relays are recorded in the receiving chat's conversation
       context with origin attribution. This makes relayed content available
       to that receiving bot's later context/memory flow, so only enable it
       for routes where both sides should inform the receiver's local context.
       Summary-mode digests and held/buffered sends are never ingested.

   Example, bridging one conversation group across Discord, WhatsApp,
   Telegram, and Matrix:

   ```json
   {
     "instances": [
       { "id": "discord-main", "platform": "discord", "url": "http://discord:${DISCORD_HEALTH_PORT:-3002}" },
       { "id": "whatsapp-main", "platform": "whatsapp", "url": "http://whatsapp:${WHATSAPP_HEALTH_PORT:-3001}" },
       { "id": "telegram-main", "platform": "telegram", "url": "http://telegram:${TELEGRAM_HEALTH_PORT:-3005}" },
       { "id": "matrix-main", "platform": "matrix", "url": "http://matrix:${MATRIX_HEALTH_PORT:-3004}" }
     ],
     "routes": [
       {
         "id": "main-channel",
         "endpoints": [
           { "instance": "discord-main", "chatId": "111111111111111111" },
           { "instance": "whatsapp-main", "chatId": "120363000000000000@g.us" },
           { "instance": "telegram-main", "chatId": "-1001111111111" },
           { "instance": "matrix-main", "chatId": "!roomid:matrix.example.org" }
         ],
         "direction": "both",
         "modeToWhatsApp": "summary",
         "modeToDiscord": "verbatim",
         "relayCommands": false,
         "ingestRelayed": false
       }
     ]
   }
   ```

   A two-endpoint route uses the same shape with only two entries in
   `endpoints`; it remains valid for simple Discord-to-WhatsApp pairs.

   `docker-compose.yml` already bind-mounts `./config/bridge-map.json`
   read-only into platform services, so no compose edit is needed for the
   standard profiles; only the file content changes.

3. **Restart both instances:**

   ```bash
   docker compose restart discord whatsapp
   ```

4. **Verify:**

   - Health endpoints still return 200 (bridging never changes `/health`):

     ```bash
     curl "http://127.0.0.1:${DISCORD_HEALTH_PORT:-3002}/health"
     curl "http://127.0.0.1:${WHATSAPP_HEALTH_PORT:-3001}/health"
     ```

   - Logs show the bridge coming up on each instance:

     ```bash
     docker compose logs -f discord | grep -i bridge
     # {"instanceId":"discord-main"} Bridge lifecycle started
     ```

     If the log instead shows `Bridge enabled but bridge map failed to load —
     bridge inert`, the JSON in `config/bridge-map.json` failed to parse or
     failed schema validation; the bridge stays off rather than crashing the
     process.

   - Send a test message in the mapped Discord channel. On the Discord side
     (verbatim by default), the WhatsApp group receives a relayed message
     with attribution:

     ```
     Ana (Discord · practice): hey what time is practice tonight
     ```

     Going the other way (WhatsApp -> Discord, summary by default), the
     message is buffered and shows up in the next digest, at most once per
     `BRIDGE_SUMMARY_INTERVAL_MINUTES`:

     ```
     WhatsApp General — last 15 min:
     • Sam: 7pm as usual
     ```

## Broker (AMQP)

The HTTP transport works well for two instances. Reach for the AMQP/RabbitMQ
transport when either is true:

- **Three or more bridged instances.** HTTP addressing is point-to-point
  (every instance needs to know every other instance's URL); AMQP routes
  through one broker via a topic exchange, so adding instances doesn't add
  point-to-point connections.
- **Durability across long peer outages.** Under HTTP, an undelivered
  message keeps retrying from the sender's outbox with growing backoff and
  eventually dead-letters if the peer stays unreachable too long. Under
  AMQP, once a message is published with `mandatory: true`, routed to the
  target instance queue, and confirmed by the broker, it sits durably on that
  queue regardless of how long the instance is down, and is delivered when it
  reconnects. If the target queue/binding does not exist yet, RabbitMQ
  returns the mandatory publish; Garbanzo treats that as a retryable transport
  failure so the sender's outbox keeps the row and retries instead of
  accepting silent loss.

To enable it:

```bash
# in .env
COMPOSE_PROFILES=discord,whatsapp,broker
BRIDGE_BROKER_PASSWORD=some-broker-password
BRIDGE_TRANSPORT=amqp
BRIDGE_BROKER_URL=amqp://garbanzo:some-broker-password@rabbitmq:<amqp-port>
```

`BRIDGE_BROKER_USER` defaults to `garbanzo` if unset. If
`BRIDGE_BROKER_PASSWORD` is not set, the `rabbitmq` container refuses to
start and logs:

```
Set BRIDGE_BROKER_PASSWORD in .env to enable the broker profile
```

The RabbitMQ management UI is reachable at `http://localhost:${RABBITMQ_MGMT_PORT:-15672}` (bound
to localhost only) with the same broker user/password. The AMQP listener is
never published to the host; it is only reachable from other containers on the
compose network by using the RabbitMQ service name.

## Worked example — three instances

This is the target topology for a group running both a community bot and a
band bot: the original WhatsApp community bot, a second linked companion
device on the same WhatsApp account for the band-facing groups, and a Discord
band bot on Discord, with the two band-facing instances bridged and the community
bot left alone.

### 1. Isolated WhatsApp community bot

The original community deployment keeps its existing `whatsapp` profile,
`.env.whatsapp`, and `config/groups.json`. If you also run the band instance
below on the same WhatsApp account, set:

```bash
WHATSAPP_CHAT_SCOPE=configured
```

That makes the instance ingest only groups enabled in its own
`config/groups.json`. DMs still work for owner commands. No bridge or
shared-memory flags are needed here unless this community instance is also
part of a route.

### 2. Band WhatsApp bot (same account companion device)

The primary path is a second linked companion device on the same WhatsApp
account. Create a second service with its own auth volume, start it, then link
it from the phone through WhatsApp's Linked Devices screen. Follow the
compose-copy pattern: duplicate the existing `whatsapp` service block under a
new name, with a fresh `INSTANCE_ID`, its own env file, and fresh volumes:

```yaml
  whatsapp-band:
    image: ghcr.io/jjhickman/garbanzo:${APP_VERSION:-latest}
    container_name: garbanzo-whatsapp-band
    profiles: ["whatsapp-band"]
    restart: unless-stopped
    env_file:
      - path: .env
        required: true
      - path: .env.whatsapp-band
        required: false
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - GARBANZO_VERSION=${APP_VERSION:-latest}
      - MESSAGING_PLATFORM=whatsapp
      - INSTANCE_ID=whatsapp-band
      - HEALTH_PORT=${WHATSAPP_BAND_HEALTH_PORT}
      - HEALTH_BIND_HOST=0.0.0.0
      - QDRANT_URL=${QDRANT_URL:-http://qdrant:${QDRANT_PORT:-6333}}
    ports:
      - "127.0.0.1:${WHATSAPP_BAND_HEALTH_PORT}:${WHATSAPP_BAND_HEALTH_PORT}"
    volumes:
      - baileys_auth_band:/app/baileys_auth
      - garbanzo_data_band:/app/data
      - ./config/groups.band.json:/app/config/groups.json:ro
      - ./config/bridge-map.json:/app/config/bridge-map.json:ro
    deploy:
      resources:
        limits:
          memory: 1G
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - qdrant
```

Add the two new named volumes alongside the existing ones:

```yaml
volumes:
  baileys_auth_band:
    name: garbanzo-bot-whatsapp-band-auth
  garbanzo_data_band:
    name: garbanzo-bot-whatsapp-band-data
```

Add `whatsapp-band` to `COMPOSE_PROFILES` and create `.env.whatsapp-band`
with the owner JID, phone number, and login settings for the shared account,
plus:

```bash
# in .env.whatsapp-band
BRIDGE_ENABLED=true
INSTANCE_ID=whatsapp-band
WHATSAPP_CHAT_SCOPE=configured
WHATSAPP_SET_PROFILE_NAME=false
```

For same-account operation, `WHATSAPP_CHAT_SCOPE=configured` must be set on
both WhatsApp instances. Each instance then sees only groups enabled in the
`groups.json` mounted into that container. Any bridged WhatsApp chat must be
an enabled group in that instance's `groups.json`, or it will not be ingested
or bridged.

Set `WHATSAPP_SET_PROFILE_NAME=false` on the secondary instance. WhatsApp
profile names are account-level, so two linked-device instances otherwise
fight over one display name. The primary instance can keep the default
`WHATSAPP_SET_PROFILE_NAME=true`.

`MONITORING_TOKEN` lives in the shared `.env` and must be the same value used
by `band-discord` below.

Because `INSTANCE_ID=whatsapp-band` is set and `QDRANT_COLLECTION` is not,
this instance automatically gets its own local collection,
`garbanzo_memory_whatsapp-band` — isolated from the community bot's
`garbanzo_memory` and from `band-discord`'s collection below, with no extra config.

The outbound safety budgets are enforced per instance, but WhatsApp still sees
one account's aggregate behavior. If the shared number is banned or limited,
every linked device on that number is affected.

### Alternative: second number for hard isolation

For hard isolation, use a second WhatsApp number instead of a same-account
linked companion device. Keep the separate service, env file, auth volume, data
volume, and `INSTANCE_ID`, then link that service to the second account. This
gives the band bot its own WhatsApp reputation and account-level profile name,
at the cost of operating another number. Treat it as a fresh account during
warm-up: `WHATSAPP_SAFETY_DAY1_LIMIT` and `WHATSAPP_SAFETY_WARMUP_DAYS` apply
from that number's first day.

### 3. Band Discord bot

The band Discord bot runs on the existing `discord` compose service/profile with
`BAND_FEATURES_ENABLED=true` (see [docs/BAND_FEATURES.md](BAND_FEATURES.md)). Add
to `.env.discord`:

```bash
BRIDGE_ENABLED=true
INSTANCE_ID=band-discord
```

`INSTANCE_ID` is deployment identity, a separate concept from persona naming
or compose service naming — the compose service stays named `discord`, but
the bridge and shared-memory system address this deployment as `band-discord`. The
same `INSTANCE_ID` also drives local memory isolation: since
`QDRANT_COLLECTION` is left unset here, this deployment's local facts land in
`garbanzo_memory_remy`, distinct from both WhatsApp instances.

### The bridge-map pair

Only the two band-facing instances are bridged; the isolated community bot
is not in the map at all. In `config/bridge-map.json`:

```json
{
  "instances": [
    { "id": "band-discord", "platform": "discord", "url": "http://discord:${DISCORD_HEALTH_PORT:-3002}" },
    { "id": "whatsapp-band", "platform": "whatsapp", "url": "http://whatsapp-band:${WHATSAPP_BAND_HEALTH_PORT}" }
  ],
  "routes": [
    {
      "id": "band-discord-band-main",
      "endpoints": [
        { "instance": "band-discord", "chatId": "222222222222222222" },
        { "instance": "whatsapp-band", "chatId": "120363111111111111@g.us" }
      ],
      "direction": "both",
      "modeToWhatsApp": "summary",
      "modeToDiscord": "verbatim",
      "relayCommands": false
    }
  ]
}
```

Replace `222222222222222222` with the real Discord channel id and
`120363111111111111@g.us` with the real WhatsApp group JID. This file is
mounted into all three containers; the community instance simply never
reads it since its bridge is off.

## Rate posture

Relays into WhatsApp go through the same outbound-safety layer as every
other WhatsApp send (rate caps, warm-up ramp, minimum inter-message delay).
A busy bridged peer sending one message per relay could otherwise burn
through those caps fast, so `modeToWhatsApp` defaults to `summary`: instead
of sending immediately, inbound relays for a route are appended to a buffer,
and a periodic flusher composes exactly one digest message per route per
`BRIDGE_SUMMARY_INTERVAL_MINUTES` tick (default 15), no matter how many
messages arrived in that window.

If a relay is set to `verbatim` toward WhatsApp and the send is held by the
outbound-safety layer (`WhatsAppOutboundHeldError` — the same "held" signal
used for normal replies, not a failure), that individual message is folded
into the route's summary buffer instead of being retried blind, so it still
goes out in the next digest flush.

The owner's existing `!whatsapp` controls apply to bridge-caused holds the
same as any other held send:

- `!whatsapp held` — list held jobs
- `!whatsapp release <id>` — manually release one
- `!whatsapp discard <id>` — drop one

Bridge code never calls the safety bypass (`sendControlText`); every WhatsApp
send it makes goes through the normal outbound-safety proxy.

`BRIDGE_MAX_TEXT` (default 1500 characters) caps both digest and verbatim
relay length. Digests that don't fit drop the oldest buffered lines first,
replacing them with a `… (+N earlier messages)` marker, and fall back to a
hard character cut (`...`) only if even the header would otherwise overflow.
Verbatim relays truncate the message body the same way, keeping the
attribution prefix intact.

Textless Discord-origin audio attachments can be relayed as transcripts when
`WHISPER_URL` is set and reachable. The receiving side sees the transcript as
a normal relayed message prefixed with `🎤`; if fetch or transcription fails,
the bridge falls back to `[voice note]`. WhatsApp voice notes do not currently
provide a fetchable URL on `InboundMessage` because Baileys media requires
`downloadMediaMessage`, so WhatsApp-origin voice notes relay as placeholders
for now. Cross-platform WhatsApp media download is a roadmap item.

## Shared memory

Each community keeps its own lore. An instance shares selected lore with
another community only when the owner permits it.

`!memory share <id>` and `!memory unshare <id>` are owner-only, DM-only
commands gated by `SHARED_MEMORY_ENABLED` (default `false` — replies with a
"Shared memory is disabled" message otherwise on both instances involved).

- `share <id>` copies one curated fact, by its local numeric id, into the
  shared Qdrant collection (`QDRANT_SHARED_COLLECTION`, default
  `garbanzo_shared`).
- `unshare <id>` removes it again.
- Every shared fact's id is namespaced as `<INSTANCE_ID>:<localId>` (falling
  back to `<MESSAGING_PLATFORM>:<localId>` when `INSTANCE_ID` is unset), so
  numeric ids from two different instances never collide in the shared
  collection.
- A peer instance only sees shared facts if it also has
  `SHARED_MEMORY_ENABLED=true`. When it does, `!memory` and `!memory search`
  label shared hits with their origin, for example
  `(shared from band-discord) — the venue changed to Parlor`, and they are never
  remapped to that peer's own local numeric ids.
- **Privacy invariant:** nothing enters the shared collection except a fact
  the owner explicitly ran `!memory share` on. Conversation history, session
  summaries, and auto-extracted facts are never auto-shared. Sharing is
  retrieval-only on a peer — a peer can read a shared fact but only the
  origin instance can unshare it.

## Troubleshooting

- **401 on `/bridge/inbound`.** The sending instance's `MONITORING_TOKEN`
  doesn't match the receiving instance's. The HTTP transport authenticates
  with a bearer token built from the sender's own `MONITORING_TOKEN`; every
  bridged instance must share the exact same value.
- **`{"status": "accepted"}` vs `{"status": "duplicate"}`.** Both are
  successful responses from `/bridge/inbound`. `accepted` means the envelope
  was new and delivered or buffered; `duplicate` means the receiver already
  processed that exact message (idempotency keyed on origin instance, chat,
  and message id) — this is expected under at-least-once delivery, not an
  error.
- **Broker refusal at container start.** If `rabbitmq` exits immediately
  with `Set BRIDGE_BROKER_PASSWORD in .env to enable the broker profile`, set
  `BRIDGE_BROKER_PASSWORD` in `.env` before including `broker` in
  `COMPOSE_PROFILES`.
- **Dead-lettered outbox rows / repeated failures.** Look for `Bridge outbox
  row dead-lettered` in the logs — a message exceeded its retry attempts (or
  hit a non-retryable error) and was dropped after logging. `Bridge summary
  buffer: route failing repeatedly, buffer keeps growing` means a route's
  digest flush has failed several times in a row and its buffer is backing
  up; check that the target chat id and instance url in
  `config/bridge-map.json` are still correct and that the target instance is
  reachable.
