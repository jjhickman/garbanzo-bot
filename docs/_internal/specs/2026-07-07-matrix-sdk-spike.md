# Matrix SDK spike (T4, WS5)

**Status:** spike complete — recommendation below awaits owner sign-off
before T5 starts. Reference implementation used throughout:
`src/platforms/telegram/` (adapter.ts, client.ts, markdown.ts,
telegram-config.ts, telegram-voice.ts) — closest analog: long-lived
connection, an HTML-adjacent formatting problem, its own 429 handling.

## 1. SDK choice

Registry/GitHub data pulled 2026-07-07:

| | `matrix-bot-sdk` | `@vector-im/matrix-bot-sdk` | `matrix-js-sdk` |
|---|---|---|---|
| License | MIT | MIT | Apache-2.0 |
| Repo | turt2live/matrix-bot-sdk | element-hq/matrix-bot-sdk (fork) | matrix-org/matrix-js-sdk |
| Latest | 0.8.0 (2026-01-16) | 0.9.0-element.1 (2026-06-04), **prerelease-only** | 41.9.0 (2026-07-07) |
| History | 0.7.1→0.8.0 gap: **2024-01-18 → 2026-01-16 (~2yr)** | ~monthly `-element.N` releases through the cycle, no stable tag ever cut | ~weekly minors, all of 2026 |
| Stars / open issues | 274 / 68 | 25 / 17 | 2,147 / 256 |
| Node engine | `>=22.0.0` | `>=24.0.0` | `>=22.0.0` |
| Bot ergonomics | autojoin, fs-backed sync-token store, HTML/reply helpers | same lineage | none — general client SDK, browser/IndexedDB-oriented store |

`matrix-js-sdk` is the best-maintained package by a wide margin (weekly
releases, largest community, first-party Element/matrix.org project) but
it's the wrong shape: a general client SDK built for Element's UI apps.
Reproducing autojoin, fs-backed sync-token persistence, and reply/HTML
helpers on top of it duplicates what `matrix-bot-sdk` already does — the
same purpose-built-beats-general-purpose logic that put grammY ahead of a
raw HTTP client for WS1. `matrix-bot-sdk`'s release gap (no stable tag for
two years) doesn't erase the fact that the Element fork has never cut a
stable tag at all and needs Node ≥24. **Recommend `matrix-bot-sdk` (plain
npm name, MIT)** for T5, gap disclosed for sign-off (§2), not glossed over.

### E2EE cost per SDK (the plan's named discriminator)

`matrix-bot-sdk` E2EE is opt-in via `RustSdkCryptoStorageProvider`,
wrapping `@matrix-org/matrix-sdk-crypto-nodejs` — an N-API **native
binary** (Olm/Megolm). Its latest release (v0.6.1, 2026-06-12) ships
prebuilds for `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, darwin,
win32 — **no `linux-arm64-musl`**. Production here is a Raspberry Pi 5
(arm64) on `node:25-alpine` (musl) (`Dockerfile:7,35`): no prebuilt binary
exists for that combination, so E2EE would mean compiling from source —
adding a Rust toolchain to the Docker build. Access token/device ID must
also stay stable across restarts (crypto storage keys off device ID); key
backup/cross-signing UX is unaddressed by the SDK's own docs.
`matrix-js-sdk`'s E2EE (`@matrix-org/matrix-sdk-crypto-wasm`,
`initRustCrypto()`) is pure WASM — no os/cpu restriction, zero deps,
released 2026-06-02 — sidestepping the native-binary/arch gap, though it
still needs bespoke store persistence and doesn't solve key-backup UX
either. That makes WASM the lower-risk *future* E2EE path on this
project's actual deployment shape — a ROADMAP forward-pointer, not a
reason to pick `matrix-js-sdk` now given its bot-ergonomics gap.

**Deferring E2EE (plan default) means** the bot can only serve
**unencrypted** rooms — materially different from Telegram/Discord (no
per-room encryption toggle there): Element defaults *new private rooms* to
encrypted. Operators must be told, in PLATFORMS.md and ideally a runtime
warning, to create/select an unencrypted room. An encrypted-room invite
isn't a crash — the bot just sees opaque ciphertext — so an explicit
warning matters more than a hard error would.

## 2. License + maintenance record (owner sign-off, amqplib precedent)

**Package:** `matrix-bot-sdk`, MIT, `github.com/turt2live/matrix-bot-sdk`.
**Cadence:** healthy through 2022-2023, then a **~2-year gap** before 0.8.0
(2026-01-16) — coincides with Element forking active work into
`@vector-im/matrix-bot-sdk` (still prerelease-only, higher Node floor).
0.8.0 lands crypto-binding upgrades and media-download fixes: active
again, not abandoned, but the gap should be named to the owner, not
assumed away. **Maintainer:** turt2live, historically a single primary
maintainer; no deprecation notice on npm or in the README.
**Open-issue health:** 68 open / 274 stars. Issue #18 ("back off on
sync/rate-limit error") open since 2019-05-12, last touched 2021-12-09,
still unresolved — confirmed by reading `src/request.ts` and
`src/MatrixClient.ts` directly: **no code path handles 429/
`M_LIMIT_EXCEEDED` today**, T5 has to build that itself (§6).
**Dependency footprint:** pulls in `request`/`request-promise` (both
long-deprecated) as its HTTP layer, plus `postgres` unconditionally even
though this project won't use that storage provider — expect
`npm run audit:deps`/Dependabot to flag `request`, known, not a surprise.

**Ask:** approve `matrix-bot-sdk` (MIT) as a new dependency with the
release-gap and no-built-in-429-retry caveats recorded, same bar as
amqplib.

## 3. Identity/config shape

`MATRIX_HOMESERVER_URL` — base URL of the homeserver; unlike Telegram/
Discord this is operator-chosen infrastructure, not a fixed vendor
endpoint, so validate as a URL, not just non-empty. `MATRIX_ACCESS_TOKEN`
— secret, same never-logged-raw rule as `TELEGRAM_BOT_TOKEN` (Matrix media
is fetched via `mxc://` URIs resolved through the client, not a
token-embedded HTTPS path, so `telegram-voice.ts`'s specific hazard
doesn't recur, but the token is still a bearer credential). `MATRIX_OWNER_ID`
— `@user:server` shape, regex-validated (`^@[^:]+:.+$`) the same way
`TELEGRAM_OWNER_ID` is validated digits-only in
`src/utils/config/index.ts`'s `superRefine`, regardless of active platform.
Validation shape mirrors Telegram's required-iff-`MESSAGING_PLATFORM=matrix`
pattern for all three vars, plus a URL-shape check on
`MATRIX_HOMESERVER_URL` (the most likely Matrix-specific config mistake).

**Bot account creation — simplest self-hoster path:** register a normal
user account for the bot on the homeserver, then mint an access token
once. **Preferred:** a `npm run setup` step doing a scripted
`m.login.password` exchange (`matrix-bot-sdk`'s `MatrixAuth` helper) —
operator enters homeserver URL + bot username/password once, wizard writes
`access_token` to `.env.matrix`, password is never stored. **Fallback
(zero code):** log into the bot account with any Matrix client (Element)
→ Settings → Help & About → Advanced → Access Token → paste into
`.env.matrix`. **Not recommended for v3.3.0:** appservice registration —
needs homeserver-admin access to install a YAML registration file and
restart the homeserver, higher friction than BotFather or a bot-invite
link; reserve for a possible future "official app" tier.

## 4. Room config file shape

Key rooms by **room ID** (`!opaque:server`), not **alias**
(`#room:server`) — matching the existing convention of keying config by a
platform's stable internal ID (Telegram chat IDs, Discord channel IDs),
never a mutable display name. Aliases can be deleted/repointed by any room
admin at any time, and resolving one needs a directory-API round trip
(`GET /_matrix/client/v3/directory/room/{roomAlias}`). Shape is 1:1 with
`TelegramChatConfigSchema` (no privacy-mode equivalent to drive a different
default):

```json
{
  "ownerId": "@owner:example.org",
  "rooms": {
    "!abcdefghijklmno:example.org": {
      "_comment": "alias #general:example.org, resolved at wizard time",
      "alias": "#general:example.org",
      "name": "general",
      "enabled": true,
      "requireMention": true
    }
  }
}
```

Operators know a room's alias day to day, not its ID — T6's wizard should
accept an alias, resolve it once, and write the resolved ID as the config
key; `alias` stays purely for human-readable context, the role `name`
already plays elsewhere.

## 5. Formatting: `org.matrix.custom.html`

Matrix messages carry plain-text `body` plus optional `formatted_body` +
`format: "org.matrix.custom.html"`. The permitted tag subset is richer than
Telegram's flat MarkdownV2 grammar (`b/i/u/strong/em/strike/code/pre/a/ul/
ol/li/h1-h6/blockquote/table/img/span/font/details/summary/…`) — real
nested HTML, so `markdown.ts`'s documented "no nested entities" v1
simplification doesn't need to carry over, though matching Telegram's scope
for v1 parity is a reasonable first cut.

What the Matrix translator needs beyond `telegram/markdown.ts`: (1) **two
output fields** — a stripped-to-plain `body` and a tag-wrapped
`formatted_body`, not one escaped string; (2) **HTML-entity escaping**
(`&`, `<`, `>`, attribute quotes) — a much smaller set than MarkdownV2's
~20 escaped punctuation characters; (3) **no parse-error retry dance** —
Telegram retries once as plain text on a strict 400 parse rejection, but
Matrix has no equivalent hard failure (malformed `formatted_body` renders
best-effort or falls back to `body` client-side), so defensive escaping
still matters but the retry path doesn't; (4) **reply fallback build/strip
(net-new)** — outbound replies must prepend an
`<mx-reply><blockquote>…</mx-reply>` block to `formatted_body` (for
clients that don't render `m.relates_to`) plus set
`m.relates_to.m.in_reply_to.event_id`, and inbound `quotedText` extraction
must **strip** that block from the referenced event before use (Telegram's
`reply_to_message.text` needed no such step — this is genuinely new
parsing surface, not a port of anything `markdown.ts` does).

R1 (format-translate property tests) should cover the HTML case and the
reply-fallback round trip.

## 6. Rate limits + flooding

Matrix limits are **homeserver-configurable** (Synapse's `rc_message`/
`rc_joins`), not fixed like Telegram's — a client-side throttle matters
*more* here since the bot can't assume a ceiling. On limit: HTTP 429,
`{"errcode": "M_LIMIT_EXCEEDED", "retry_after_ms"?}`; `retry_after_ms` is
spec-deprecated for a `Retry-After` header, but homeservers may send
either — check both.

Confirmed by reading `matrix-bot-sdk`'s `src/request.ts`/`src/MatrixClient.ts`:
**no built-in retry/backoff** (matches the stale issue #18, §2). T5 needs a
wrapper structurally identical to `telegram/client.ts`'s
`telegramApiRequest` — read the hint, sleep once, retry once, same
`MAX_RETRY_AFTER_MS` cap. `bridge/relay-deliver` needs a `matrix` case
mirroring the existing telegram/discord 429 handling. New work, not reuse.

## 7. Sync/long-poll model

`/sync` is a long-poll `GET` with `timeout` + a `since` token; each
response returns `next_batch` to pass as the next `since` — parallel to
Telegram's `getUpdates` offset, but a heavier worst case: **initial sync**
(no `since`, i.e. first boot or a lost token) returns full room state plus
recent timeline for *every* joined room. Cheap for one or two rooms;
multi-MB/multi-second for a busy account. Mitigate with a sync `Filter`
(lazy-loaded members + bounded timeline) configured deliberately in T5, not
left at defaults.

**Since-token persistence is a new mutable-state seam.**
`SimpleFsStorageProvider` persists sync token + filter ID + autojoin
bookkeeping to a JSON file, so restarts resume from `next_batch` instead of
a full initial sync. Telegram's long-polling is stateless between restarts
today — this is *stronger* continuity than Telegram has, but it's new
persistence machinery: a file at `GARBANZO_HOME/data/matrix-sync.json`
(alongside the SQLite DB and Baileys auth state already in `data/`), so it
needs a gitignore entry, a compose volume mount, a doctor config-existence
check, and a WS4-phase-2 export/import decision (not a secret, but
instance-identity-bearing state, closer to `bridge_outbox` than a config
file). Clean stop: `client.stop()` should abort the in-flight long-poll so
the sync loop exits promptly — verify no dangling request survives
SIGTERM, mirroring `telegram/client.ts`'s `stop()`.

## 8. Seam-checklist deltas vs WS1, and v3.3.0 risk

T1 already landed the mechanical enum/union/bridge-map groundwork
(verified: `messaging-platform.ts`, `envelope.ts`, `bridge-map.ts:29`,
`core.ts:6` all include `'matrix'`). Beyond factory + runtime contract test
+ compose service/volume + prometheus job + wizard + doctor +
PLATFORMS.md/README + bridge translate/relay-deliver + prompt-eval case +
helm values, Matrix needs — and each is a real, if individually small,
v3.3.0 risk, none release-blocking on its own:

- **Sync-token store** (§7) — new file, volume, doctor check, WS4
  export/import question. No Telegram/Discord analog.
- **Alias resolution** (§4) — wizard-time alias→room-ID lookup. No
  Telegram/Discord analog.
- **Homeserver-URL validation + doctor reachability probe.** Doctor
  doesn't probe Telegram/Discord API reachability either, so this isn't
  strictly a gap Telegram already closed — but a self-hostable homeserver
  is far more typo/downtime-prone than a fixed third-party endpoint. T6
  nice-to-have.
- **Encrypted-room detection.** `m.room.encryption` state is visible
  without decryption — log/warn rather than silently fail there (§1). No
  Telegram/Discord analog.
- **Federation/bridge-puppet quirks.** A room itself bridged from another
  network (mautrix-style) delivers ghost/puppet sender IDs and join/leave
  churn unrelated to real membership — welcome hook isn't expected to
  handle this correctly in v3.3.0; document as a known limitation.
- **Node ≥22 floor** — above the documented 20+ floor
  (`package.json:73`); fine under `node:25-alpine`, a real constraint for
  the no-Docker/`npx` quickstart path. Needs a PLATFORMS.md/QUICKSTART
  callout.
- **429 handling and reply-fallback parsing are hand-built, not reused**
  (§5, §6) — real T5 scope Telegram mostly got for free.
- **Maintenance signal is weaker than grammY's** — the two-year release
  gap (§2) should reach the owner plainly, not as a rubber-stamp line.
- **Homeserver diversity** — the soak gate proves "works on the owner's
  homeserver," a narrower guarantee than "works on Telegram's fixed API."

Cumulatively this is a materially bigger lift than Telegram was, despite
both shipping in one release — exactly what R7's capacity-valve ordering
(slip web UI phase 1, then Matrix, before the Telegram deliverable) already
anticipates. Nothing found here argues for slipping Matrix preemptively.

## Build-sequence task sketch

**T5 — Matrix adapter core** (mirrors T2): add `matrix-bot-sdk` (pending §2
sign-off) + Decisions Log entry; `src/utils/config/matrix.ts`
(`MATRIX_HOMESERVER_URL`/`MATRIX_ACCESS_TOKEN`/`MATRIX_OWNER_ID`/
`MATRIX_ROOMS_CONFIG_PATH`, wired into `index.ts`'s `superRefine`);
`src/platforms/matrix/matrix-config.ts` (`MatrixRoomsConfigSchema`, §4);
`src/platforms/matrix/html.ts` (markdown→HTML translator, escaping,
mx-reply build/strip, §5, with property tests); `src/platforms/matrix/
client.ts` (`MatrixClient` wiring — `SimpleFsStorageProvider` at
`GARBANZO_HOME/data/matrix-sync.json`, lazy-load-members filter,
`AutojoinRoomsMixin`, 429-retry wrapper §6, clean `stop()`);
`src/platforms/matrix/adapter.ts` (`PlatformMessenger` impl via
`sendHtmlText`/media upload-download over `mxc://`); `inbound.ts`/
`processor.ts` (map `m.room.message`/`m.room.member` to `InboundMessage`,
`requireMention` gating, quotedText via mx-reply strip, voice/audio
download); `runtime.ts`/`welcome.ts`/`platforms/index.ts` matrix branch
(mirror Telegram shape); `persona.ts` formatting cases;
`bridge/relay-deliver` matrix case; tests (HTML translator properties,
mx-reply round trip, credential hygiene, runtime contract).

**T6 — Matrix deployment seams** (mirrors T3): `docker-compose.yml`
(matrix service/profile, health port `matrix:3004`, sync-token data
volume, `.env.matrix`; compose contract test + pinned volume/service list
updated explicitly, R2 pattern); `monitoring/prometheus.yml`
(`matrix:3004` scrape job, down-target hygiene note); `scripts/
setup-fields.mjs`/`setup.mjs` (wizard menu entry, homeserver + access-token
prompts — scripted login preferred, manual fallback, §3 — alias→ID
resolution writing `config/matrix-rooms.json`); `src/cli/doctor.ts`
(config-file-existence entries for `.env.matrix`, `config/
matrix-rooms.json`, sync-token file; optional reachability probe, §8);
`PLATFORMS.md`/README (bootstrap walkthrough, Node 22+ callout, explicit
unencrypted-room instruction, homeserver-diversity note);
`deploy/helm/values.platform` matrix entry; live soak — an unencrypted
room on the owner's homeserver, bridged to Discord, before tagging
(mirrors Telegram's soak gate).

## RECOMMENDATION (for owner sign-off)

- **SDK:** `matrix-bot-sdk` (npm name `matrix-bot-sdk`, MIT,
  `github.com/turt2live/matrix-bot-sdk`) — **not** the
  `@vector-im/matrix-bot-sdk` prerelease fork (Node ≥24, no stable tag) and
  **not** `matrix-js-sdk` (best-maintained but wrong shape for a headless
  bot). Sign-off should explicitly acknowledge the ~2-year release gap
  (2024-01→2026-01) and the absence of built-in 429 retry handling — both
  real, both manageable, neither a reason to pick a worse-fitting
  alternative.
- **E2EE posture:** defer, confirming the plan's default. Deferring is
  cheap; shipping it is not — the native crypto module has no
  `linux-arm64-musl` prebuild for this project's actual deployment target
  (Raspberry Pi 5 + `node:25-alpine`), so enabling E2EE today means adding
  a Rust toolchain to the Docker build. Document "invite the bot only into
  unencrypted rooms" explicitly in PLATFORMS.md and in-product logging.
- **Config shape:** `MATRIX_HOMESERVER_URL` + `MATRIX_ACCESS_TOKEN` +
  `MATRIX_OWNER_ID` (`@user:server`, regex-validated), required iff
  `MESSAGING_PLATFORM=matrix`; `config/matrix-rooms.json` keyed by **room
  ID** (never alias) with wizard-time alias resolution; a new durable
  sync-token file at `GARBANZO_HOME/data/matrix-sync.json` that T6 must
  wire into compose volumes, doctor, and (later) WS4 export/import.
