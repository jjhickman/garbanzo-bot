# Remy Sub-project 0 — "Discord Goes Real" (Foundation) — Design Spec

**Date:** 2026-07-03
**Status:** Draft (autonomous build; owner reviews at PR)
**Branch:** `feat/remy-discord-foundation`
**Part of:** the Remy band-bot initiative (4 sub-projects: **foundation** → band memory → practice → songwriting). Shared codebase — Remy is garbanzo-bot run with `MESSAGING_PLATFORM=discord`.

## Summary

Make the Discord platform production-grade so a bot can **observe and act in a Discord server** the way the WhatsApp path does today. The current Discord runtime is an interactions webhook that only answers a single slash command and cannot see channel messages; this sub-project replaces it with a real **Gateway (websocket) connection** and wires the existing (platform-agnostic) feature/scheduler/owner machinery into Discord. It benefits Garbanzo's own community Discord as much as Remy.

No band-specific features here — those are sub-projects 1–3. This is purely the platform substrate they need.

## Goals

1. **Ambient observation:** a real Discord Gateway connection (via `discord.js`) feeds `MESSAGE_CREATE` (and member-join) events into the existing `processDiscordEvent` pipeline, so mentions, moderation, memory ingestion, and passive detection work.
2. **Correct owner model:** a Discord owner identity for gating owner-only DM commands, and a working escalation target (moderation/feedback DMs to the owner) — replacing the broken WhatsApp-JID-as-channel-id assumption.
3. **Per-channel / role config:** Remy is active only in configured channels, honors a per-channel `requireMention`, and can distinguish band-member roles from everyone else.
4. **Remy persona + platform-correct formatting:** a `docs/personas/discord.md`, and formatting instructions selected by platform (Discord markdown, not WhatsApp `*markup*`).
5. **Bound runtime:** schedulers (digest / weekly recap / event reminders / intro catch-up), owner commands, and welcome-on-join run under Discord, with real lifecycle teardown (`stop()` closes the client).
6. **No regressions** to the WhatsApp path; band code stays flag-gated and inert unless enabled.

## Non-goals (deferred)

- Discord-native niceties: native polls, threads/forum channels, Scheduled Events, slash-command subcommands/autocomplete, buttons/modals, voice-channel presence/recording. These land in the sub-projects that actually use them (practice → polls/events; songwriting → threads/attachments).
- Attachment/vision ingestion on Discord (audio clips, images) — sub-project 3 (songwriting) turns this on; here we only ensure the plumbing (`hasVisualMedia`) is not lied about.
- Any band features (memory schema, rehearsal, songwriting).

## Decisions

- **`discord.js`** for the Gateway (per AGENTS.md "use existing tools first" — hand-rolling a gateway websocket is what that rule warns against). New dependency (ask-first; covered by the owner's autonomous-build mandate; noted in the PR).
- **Gateway is the production inbound path.** The existing interactions webhook (`gateway-runtime.ts`) is retained only as an optional slash-command surface behind a flag; the Gateway is default when `DISCORD_BOT_TOKEN` is set. (Slash commands are a later concern; the Gateway sees everything a band needs.)
- **Two owner concepts on Discord:** `DISCORD_OWNER_ID` (a Discord *user* id, used for gating) and a resolved **owner DM channel id** (created once at startup via `POST /users/@me/channels`, used as the escalation `sendText` target). The core pipeline keeps taking a single `ownerId` string; for Discord that string is the resolved DM channel id, and a separate owner-user-id is used for identity checks.
- **Discord config lives in `config/discord-channels.json`** (a Discord-shaped analogue to `config/groups.json`), loaded through a small Discord config module. `groups-config.ts` stays WhatsApp-JID-shaped and untouched; Discord gets its own channel/role model rather than overloading the JID model.
- **Persona/formatting becomes platform-aware** in `ai/persona.ts` — the currently-hardcoded WhatsApp markup line is replaced by a per-platform formatting instruction.

## Architecture

```
Discord server
   │  (gateway websocket, discord.js)
   ▼
src/platforms/discord/gateway-client.ts   ← NEW: discord.js Client, intents, event→payload mapping
   │  maps discord.js Message → DiscordMessageCreate payload
   ▼
processDiscordEvent(messenger, payload, env)   ← EXISTS (processor.ts), minor env additions
   │
   ├─ createDiscordAdapter(token)  ← EXISTS (adapter.ts): PlatformMessenger (text/reply/doc/audio/delete)
   ├─ processInboundMessage → moderation / intro / events / dispatch  ← EXISTS (core), platform-agnostic
   └─ processGroupMessage / handleOwnerDM  ← EXISTS, gated by Discord config + owner id

src/platforms/discord/runtime.ts   ← REWORK: start gateway, bind schedulers, real stop()
src/platforms/discord/discord-config.ts   ← NEW: channel/role/owner config (config/discord-channels.json)
docs/personas/discord.md   ← NEW: Remy persona
src/ai/persona.ts   ← EDIT: platform-aware formatting instruction
src/index.ts   ← EDIT: guard WhatsApp login bootstrap to MESSAGING_PLATFORM=whatsapp
```

### Units

- **`gateway-client.ts`** (new) — owns the `discord.js` `Client`: configures intents (`Guilds`, `GuildMessages`, `MessageContent`, `GuildMembers`, `GuildMessageReactions`), logs in with the bot token, resolves bot identity on `ready`, maps each `messageCreate` `Message` to the `DiscordMessageCreate` shape `processor.ts` already validates, and calls `processDiscordEvent`. Exposes `start()` and `stop()` (`client.destroy()`). Also emits `guildMemberAdd` → welcome hook. One responsibility: bridge discord.js ↔ the existing normalized pipeline. No feature logic.
- **`discord-config.ts`** (new) — loads/validates (Zod) `config/discord-channels.json`: `ownerId` (Discord user id), `channels` (id → `{ name, enabled, requireMention, features?, bandRoleIds? }`), optional global `bandRoleIds`. Exposes `isDiscordChannelEnabled(channelId)`, `discordChannelRequiresMention(channelId)`, `isDiscordFeatureEnabled(channelId, feature)`, `isBandMember(roleIds)`, `getDiscordOwnerId()`. Defaults: unknown channel → **disabled** (opt-in, so Remy doesn't talk everywhere), `requireMention` default `true`.
- **`discord/runtime.ts`** (rework) — when `DISCORD_BOT_TOKEN` present: construct the adapter, resolve the owner DM channel id, start the gateway client, and register the schedulers (`scheduleDigest`, `scheduleWeeklyRecap` if enabled, `scheduleEventReminders`, intro catch-up) bound to the Discord messenger + a Discord target-channel resolver. Track disposers like the WhatsApp runtime. `stop()` disposes schedulers and destroys the client. Demo mode unchanged.
- **`processor.ts`** (edit) — thread Discord config into env: use `isDiscordChannelEnabled` for `isGroupEnabled`, `isDiscordFeatureEnabled` for feature gating, `discordChannelRequiresMention` for the mention branch, and **owner-gate `handleOwnerDM`** (only the configured `DISCORD_OWNER_ID` gets the DM assistant; others get a polite decline or nothing). Wire `introductionsChatId`/`eventsChatId` from Discord config so passive intro/event detection can run in the right channels.
- **`persona.ts`** (edit) — replace the hardcoded WhatsApp-markup line with `buildFormattingInstruction(config.MESSAGING_PLATFORM)`: Discord → "**bold**, *italic*, ~~strike~~, \`code\`, > quotes"; WhatsApp → current `*bold* _italic_ ~strike~`. Same for the Ollama distilled prompt.

## Scheduler binding on Discord

The schedulers (`digest.ts`, `recap.ts`, `event-reminders.ts`, `introductions-catchup.ts`) currently take a `WASocket`. They are logic-agnostic but typed to Baileys. Two options; the spec chooses **B**:

- **(A)** Generalize each scheduler to take a `PlatformMessenger` + a channel resolver. Cleanest long-term but touches WhatsApp code broadly.
- **(B, chosen)** Add thin Discord scheduler binders in `discord/` that reuse the *feature* functions (the pure recap/digest/event-reminder builders, which are already platform-agnostic — they return text/structured data) and send via the Discord messenger to a configured target channel. This keeps WhatsApp untouched and mirrors how those features are structured (feature logic vs the WhatsApp-specific send wrapper). Where a scheduler's send path is entangled with Baileys, extract the pure builder into the feature file (small, behavior-preserving) and call it from both.

The Discord target channel for scheduled posts (digest/recap) comes from `discord-config.ts` (e.g. a `digestChannelId` / `recapChannelId`, falling back to the owner DM).

## Owner escalation + DM gating

- At startup, resolve the owner DM channel: `POST /users/@me/channels {recipient_id: DISCORD_OWNER_ID}` → channel id. Pass **that channel id** as `env.ownerId` to `processInboundMessage`/`processGroupMessage` so the existing `adapter.sendText(env.ownerId, …)` escalation (moderation alerts, feedback) works unchanged.
- Identity gating for the DM assistant and owner commands uses `DISCORD_OWNER_ID` (the user id from `inbound.senderId`), not the channel id. `handleOwnerDM` checks `senderId === DISCORD_OWNER_ID` before running the assistant / owner commands.

## Config (new keys, Zod-validated, documented in `.env.example`)

- `DISCORD_OWNER_ID` — Discord user id for owner gating/escalation (required for the Gateway path).
- `DISCORD_GATEWAY_ENABLED` — default `true` when token present; set `false` to fall back to interactions-only.
- `DISCORD_DIGEST_CHANNEL_ID` / `DISCORD_RECAP_CHANNEL_ID` — optional scheduled-post targets (fallback: owner DM).
- Existing `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, interactions/demo keys retained.
- `config/discord-channels.json` — per-channel config (see `discord-config.ts`).

## Error handling / degradation

- Gateway disconnects: `discord.js` auto-reconnects; log connect/disconnect/resume; never crash the process on a single event handler error (wrap event handlers in try/catch → `logger`, mirroring existing discipline).
- Owner DM channel resolution failure: log and continue with escalation disabled (features still work); do not crash startup.
- Unknown/disabled channel: message ignored (opt-in model).
- Missing `DISCORD_OWNER_ID` on the Gateway path: log a clear fatal like the existing runtime does.
- `index.ts` must not run WhatsApp login bootstrap under `MESSAGING_PLATFORM=discord`.

## Testing

- **Gateway client** (mocked `discord.js` `Client`): a `messageCreate` maps to the correct `DiscordMessageCreate` payload and calls `processDiscordEvent`; a bot-authored message is ignored; `guildMemberAdd` fires the welcome hook; `stop()` calls `client.destroy()`. No live Discord (like WhatsApp tests mock the socket).
- **discord-config**: channel enable/disable (unknown → disabled), requireMention default, feature gating, band-role check, owner id.
- **Owner gating**: `handleOwnerDM` runs for `DISCORD_OWNER_ID`, declines otherwise. Escalation `sendText` targets the resolved DM channel id.
- **Persona formatting**: `buildFormattingInstruction('discord')` vs `'whatsapp')` selects the right markup; discord persona doc loads when `MESSAGING_PLATFORM=discord`.
- **Runtime binding**: starting the Discord runtime registers schedulers and `stop()` disposes them + destroys the client (spy-based).
- **Regression**: full suite stays green; WhatsApp runtime untouched; `MESSAGING_PLATFORM=whatsapp` unaffected. CI adds no live Discord; unit tests mock the client. `discord.js` is a prod dependency — verify it doesn't leak dev-only bloat into the pruned image (mirror the Qdrant peer-dep lesson).

## Rollout / what the owner must provide

1. Create a Discord application + bot, enable the **Message Content** privileged intent (+ Server Members), invite it to the band server with send/read permissions.
2. Set `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY` (if using interactions too), `DISCORD_OWNER_ID`, and fill `config/discord-channels.json` with the band's channels.
3. Deploy with `MESSAGING_PLATFORM=discord`. Rollback: `DISCORD_GATEWAY_ENABLED=false` (interactions-only) or revert to WhatsApp.

## Open questions (proceeding on the stated default; owner can redirect at PR)

1. Scheduler binding A vs B — proceeding with **B** (Discord binders reusing pure feature builders) to keep WhatsApp untouched.
2. Whether to keep the interactions webhook at all — proceeding to **retain it behind `DISCORD_GATEWAY_ENABLED=false`** rather than delete, since it's cheap and already tested.
