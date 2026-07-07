# Remy Discord Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Discord platform production-grade — a real discord.js Gateway feeding the existing `processDiscordEvent` pipeline, a correct Discord owner model, per-channel/role config, a Remy persona with platform-correct formatting, and bound schedulers/welcome with real lifecycle teardown.

**Architecture:** A new `discord.js` Gateway client maps `messageCreate`/`guildMemberAdd` events into the payload shape `processor.ts` already validates and calls the existing pipeline. A Discord config module gates channels/features/roles. The runtime starts the gateway, resolves the owner DM channel for escalation, binds thin scheduler wrappers that reuse the existing pure feature builders, and tears everything down on stop. No band features.

**Tech Stack:** TypeScript (ESM), Node 20+, `discord.js` v14, Zod, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-03-remy-discord-foundation-design.md`. Every task serves it.
- **TypeScript strict**, no `any`, ESM (`import`/`export`, `.js` extensions), never CommonJS. Pino `logger` only (no `console.log`). Zod for external input (config, JSON, event payloads). `kebab-case.ts`, one concern per file, ~300 line ceiling.
- **No WhatsApp regressions:** do not modify `src/platforms/whatsapp/**` or change WhatsApp behavior. Discord binders reuse the pure builders in `src/features/**` (which are platform-agnostic) — never import Baileys.
- **No band features** (memory schema, rehearsal, songwriting) — this sub-project is platform substrate only.
- **Tests mock `discord.js`** (a fake `Client`); no live Discord connection in tests or CI. The full `npm run test` suite stays green.
- **Two owner ids on Discord:** `DISCORD_OWNER_ID` = Discord *user* id (identity gating); the resolved DM **channel id** is what the core pipeline receives as its `ownerId` string (send target for escalation).
- **Opt-in channels:** an unknown/unconfigured Discord channel is **disabled** (Remy stays silent there). `requireMention` defaults to `true`.
- **Verify env prefix** (config validation exits without it): `MESSAGING_PLATFORM=discord OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter DISCORD_OWNER_ID=111 DISCORD_BOT_TOKEN=test_tok`. (Most existing tests use `MESSAGING_PLATFORM=whatsapp`; keep that for whatsapp-path tests.)
- **Commits:** `type(scope): desc`; author `Josh Hickman <25596491+jjhickman@users.noreply.github.com>`. Run `npm run check` (with `PATH="$HOME/.local/bin:$PATH"` so gitleaks resolves) before commits that touch source. Never merge — push branch, open PR, owner merges.
- **Branch:** `feat/remy-discord-foundation` (spec already committed there).

---

## File Structure

**Create:**
- `docs/personas/discord.md` — Remy persona (loaded when `MESSAGING_PLATFORM=discord`).
- `src/platforms/discord/discord-config.ts` — channel/role/owner config loader + predicates.
- `config/discord-channels.example.json` — documented example (real `config/discord-channels.json` is gitignored, owner-supplied).
- `src/platforms/discord/discord-owner.ts` — resolve the owner DM channel id (REST).
- `src/platforms/discord/gateway-client.ts` — discord.js Client bridge → `processDiscordEvent`.
- `src/platforms/discord/schedulers.ts` — Discord scheduler binders (digest/recap/event-reminders) reusing pure builders.
- Tests: `tests/persona-formatting.test.ts`, `tests/discord-config.test.ts`, `tests/discord-owner.test.ts`, `tests/discord-gateway-client.test.ts`, `tests/discord-schedulers.test.ts`, `tests/discord-runtime-wiring.test.ts`, plus additions to `tests/discord-demo.test.ts` for processor gating.

**Modify:**
- `src/ai/persona.ts` — platform-aware formatting instruction (replace hardcoded WhatsApp markup).
- `src/utils/config.ts` + `.env.example` — new Discord keys.
- `src/platforms/discord/processor.ts` — Discord-config gating + owner-DM gating + env plumbing.
- `src/platforms/discord/runtime.ts` — start gateway, resolve owner DM channel, bind schedulers, real `stop()`.
- `src/index.ts` — guard WhatsApp login bootstrap to `MESSAGING_PLATFORM=whatsapp`.
- `package.json` — add `discord.js`.
- `AGENTS.md` — decisions-log entry (Discord goes real; opt-in channels; two-owner-id model).

---

## Task 1: Platform-aware formatting + Remy persona doc

**Files:**
- Modify: `src/ai/persona.ts` (the hardcoded `'Keep responses concise and use WhatsApp formatting (*bold*, _italic_, ~strike~).'` line, and the Ollama prompt's equivalent)
- Create: `docs/personas/discord.md`
- Test: `tests/persona-formatting.test.ts`

**Interfaces:**
- Produces: `buildFormattingInstruction(platform: MessagingPlatform): string` (exported from `persona.ts`). Discord → Discord markdown; whatsapp/default → current WhatsApp markup.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/persona-formatting.test.ts
process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it } from 'vitest';
import { buildFormattingInstruction } from '../src/ai/persona.js';

describe('buildFormattingInstruction', () => {
  it('uses Discord markdown for discord', () => {
    const s = buildFormattingInstruction('discord');
    expect(s).toMatch(/\*\*bold\*\*/);
    expect(s).toMatch(/~~strike~~/);
    expect(s).not.toMatch(/~strike~[^~]/);
  });
  it('uses WhatsApp markup for whatsapp', () => {
    const s = buildFormattingInstruction('whatsapp');
    expect(s).toMatch(/\*bold\*/);
    expect(s).toMatch(/_italic_/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/persona-formatting.test.ts`
Expected: FAIL — `buildFormattingInstruction` not exported.

- [ ] **Step 3: Implement**

In `src/ai/persona.ts`, add (import `MessagingPlatform` type from `../core/messaging-platform.js`):

```typescript
export function buildFormattingInstruction(platform: MessagingPlatform): string {
  if (platform === 'discord') {
    return 'Keep responses concise. Use Discord markdown: **bold**, *italic*, ~~strike~~, `code`, > quotes.';
  }
  return 'Keep responses concise and use WhatsApp formatting (*bold*, _italic_, ~strike~).';
}
```

Replace the hardcoded WhatsApp-markup string in `buildSystemPrompt` with `buildFormattingInstruction(config.MESSAGING_PLATFORM)`. In `buildOllamaPrompt`, replace its `- Use WhatsApp formatting: *bold*, _italic_, ~strike~.` line with a platform-selected equivalent (Discord: `- Use Discord markdown: **bold**, *italic*, ~~strike~~.`).

- [ ] **Step 4: Create `docs/personas/discord.md`** — Remy persona. Keep it in the same shape as `docs/PERSONA.md` (identity, personality, bot-awareness, interaction rules, refusal boundaries) but for **Remy, a band's Discord assistant**: helps the band practice, write music, and coordinate; knows the band's members, songs, and gear; warm, direct, music-literate; not Boston/meetup themed. Do NOT include formatting markup instructions here (they come from `buildFormattingInstruction`). Reuse the untrusted-input / refusal-boundary sections from `docs/PERSONA.md` adapted to a band server (member privacy, no impersonation, injection resistance).

- [ ] **Step 5: Run to verify pass + full check**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/persona-formatting.test.ts` → PASS.
Then `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npm run check`.

- [ ] **Step 6: Commit**

```bash
git add src/ai/persona.ts docs/personas/discord.md tests/persona-formatting.test.ts
git commit -m "feat(discord): platform-aware formatting + Remy persona doc"
```

---

## Task 2: Config keys + Discord config module

**Files:**
- Modify: `src/utils/config.ts` (Discord block ~154-161), `.env.example`
- Create: `src/platforms/discord/discord-config.ts`, `config/discord-channels.example.json`
- Test: `tests/discord-config.test.ts`

**Interfaces:**
- Produces (config): `DISCORD_OWNER_ID?: string`, `DISCORD_GATEWAY_ENABLED: boolean` (default `true`), `DISCORD_DIGEST_CHANNEL_ID?: string`, `DISCORD_RECAP_CHANNEL_ID?: string`, `DISCORD_CHANNELS_CONFIG_PATH: string` (default `config/discord-channels.json`).
- Produces (module): `getDiscordOwnerId(): string | undefined`, `isDiscordChannelEnabled(channelId: string): boolean`, `discordChannelRequiresMention(channelId: string): boolean`, `isDiscordFeatureEnabled(channelId: string, feature: string): boolean`, `getDiscordChannelName(channelId: string): string | undefined`, `isBandMember(roleIds: string[]): boolean`, `getDiscordIntroductionsChannelId(): string | null`, `getDiscordEventsChannelId(): string | null`. Config shape (Zod):
  ```
  { ownerId?, bandRoleIds?: string[], introductionsChannelId?, eventsChannelId?,
    channels: Record<channelId, { name, enabled: boolean(default true),
      requireMention: boolean(default true), features?: string[], bandRoleIds?: string[] }> }
  ```

- [ ] **Step 1: Write the failing test** — cover: unknown channel disabled; configured `enabled:false` disabled; `requireMention` default true and override false; `isDiscordFeatureEnabled` true when features omitted, gated when features array present; `isBandMember` true when a role intersects global or channel `bandRoleIds`; owner id read from config env first then file. Load the module against a temp JSON fixture (write a tmp file, point `DISCORD_CHANNELS_CONFIG_PATH` at it). Assert defaults when the file is absent (all channels disabled, owner id from env).

- [ ] **Step 2: Run → FAIL** (module missing). Command uses the discord env prefix from Global Constraints.

- [ ] **Step 3: Implement** config keys in `config.ts` (place in the Discord block), `.env.example` docs, `config/discord-channels.example.json` (a 2-channel example with comments-as-`_comment` keys), and `discord-config.ts`:
  - Load JSON at module init via `readFileSync` guarded by `existsSync` (like `groups-config.ts`); parse with Zod; on missing file or parse error, log a warning and use an empty-channels default (everything disabled). `getDiscordOwnerId` returns `config.DISCORD_OWNER_ID ?? parsed.ownerId`. Predicates read the parsed map with the opt-in defaults. `isBandMember(roleIds)` returns true if any roleId is in global `bandRoleIds` (channel-scoped role check is available via a channel-aware overload only if needed — keep the global check for now).

- [ ] **Step 4: Run → PASS + full check.**

- [ ] **Step 5: Commit** `feat(discord): channel/role/owner config module + keys`

---

## Task 3: Owner DM channel resolution

**Files:**
- Create: `src/platforms/discord/discord-owner.ts`
- Test: `tests/discord-owner.test.ts`

**Interfaces:**
- Consumes: `discordApiRequest`-style REST (reuse the fetch pattern from `adapter.ts`, or accept an injectable `fetchFn`).
- Produces: `resolveOwnerDmChannelId(token: string, ownerUserId: string, deps?: { fetchFn?: typeof fetch }): Promise<string | null>` — `POST https://discord.com/api/v10/users/@me/channels` with `{ recipient_id: ownerUserId }`, returns the channel `id`, or `null` (logged) on failure. Never throws.

- [ ] **Step 1: Write the failing test** — inject a fake `fetchFn`: success returns `{id:'dm123'}` → assert `'dm123'` and that the POST body was `{recipient_id:'owner1'}`; non-ok response → `null` (no throw); thrown fetch → `null`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with an injectable `fetchFn = fetch`, `authorization: Bot <token>`, try/catch → `logger.warn` + `null`.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(discord): resolve owner DM channel for escalation`

---

## Task 4: Processor gating (Discord config + owner-DM gate)

**Files:**
- Modify: `src/platforms/discord/processor.ts` (`processDiscordInbound`, `env` shape)
- Test: extend `tests/discord-demo.test.ts` (or new `tests/discord-processor-gating.test.ts`)

**Interfaces:**
- Consumes: Task 2 predicates (`isDiscordChannelEnabled`, `discordChannelRequiresMention`, `isDiscordFeatureEnabled`, `getDiscordIntroductionsChannelId`, `getDiscordEventsChannelId`), and a new env field.
- Produces: `processDiscordEvent(messenger, payload, env)` where `env = { ownerId: string; ownerUserId?: string; botUserId?: string }` — `ownerId` is the send/escalation target (DM channel id), `ownerUserId` is the identity for gating.

- [ ] **Step 1: Write the failing test** — mock the discord-config module: (a) a message in a disabled channel is ignored (no `messenger.sendText`); (b) in an enabled `requireMention:false` channel, a non-mention message is processed (calls through); (c) `handleOwnerDM` runs only when `senderId === env.ownerUserId`, otherwise no assistant call; (d) `isGroupEnabled`/feature gating routes through the Discord predicates. Use the demo adapter outbox to assert sends.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**
  - Replace `isGroupEnabled: () => true` with `isGroupEnabled: (chatId) => isDiscordChannelEnabled(chatId)`; wire `introductionsChatId`/`eventsChatId` from the Discord config predicates (so passive intro/event detection runs in configured channels); keep `handleIntroduction`/`handleEventPassive` as before (the core pipeline calls the real feature handlers — leave those wired as the WhatsApp path does via the shared feature functions; if they are currently stubbed to `null`, wire them to the same `handleIntroduction`/`handleEventPassive` feature entry points the WhatsApp handler uses).
  - In `handleGroupMessage`: when `discordChannelRequiresMention(m.chatId)` is `false`, treat the message as addressed even without a mention/bang (so Remy can converse in a dedicated channel); otherwise keep the mention-or-bang requirement. Pass `isFeatureEnabled: (chatId, feature) => isDiscordFeatureEnabled(chatId, feature)` to `processGroupMessage`.
  - In `handleOwnerDM`: return early unless `env.ownerUserId && m.senderId === env.ownerUserId`.
  - Thread `ownerUserId` through `processDiscordEvent` → `processDiscordInbound` env.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(discord): gate channels/features + owner DM by Discord config`

---

## Task 5: Gateway client (discord.js)

**Files:**
- Modify: `package.json` (add `discord.js`)
- Create: `src/platforms/discord/gateway-client.ts`
- Test: `tests/discord-gateway-client.test.ts`

**Interfaces:**
- Consumes: `createDiscordAdapter` (adapter.ts), `processDiscordEvent` (Task 4 env shape), `buildWelcomeMessage` (features/welcome.ts) for member joins.
- Produces: `createDiscordGatewayClient(deps: { token, ownerId, ownerUserId, clientFactory?: () => DiscordClientLike }): { start(): Promise<void>; stop(): Promise<void> }` where `DiscordClientLike` is a minimal interface (`on`, `once`, `login`, `destroy`, `user`) so tests inject a fake and never construct the real client.

- [ ] **Step 1: Write the failing test** — inject a fake client that records handlers. Assert: `start()` registers `messageCreate`, `guildMemberAdd`, `ready`; calls `login(token)`. Simulate a `messageCreate` with a fake discord.js Message (author non-bot) → asserts `processDiscordEvent` is called (mock it) with a payload whose `channel_id`/`author.id`/`content` match. A bot-authored message → not forwarded. `guildMemberAdd` → sends a welcome via the adapter (mock adapter). `stop()` → calls `destroy()`. Handler errors are caught (a throwing processDiscordEvent doesn't reject the event).
- [ ] **Step 2: Run → FAIL** (and `npm install discord.js`).
- [ ] **Step 3: Implement:**
  - `npm install discord.js`.
  - Define `DiscordClientLike` minimal interface; `defaultClientFactory()` lazily constructs `new Client({ intents: [Guilds, GuildMessages, MessageContent, GuildMembers, GuildMessageReactions] })` via a dynamic `import('discord.js')` so tests never load it.
  - `mapMessageToPayload(msg)`: build the `DiscordMessageCreate` shape processor expects (`id, channel_id, guild_id?, content, author:{id,bot}, timestamp, mentions:[{id}], referenced_message?, attachments`). Pull mentions from `msg.mentions.users` keys; `referenced_message` from `msg.reference`/`msg.mentions.repliedUser` if available (best-effort; `content` of the referenced message if cheaply present, else omit).
  - `messageCreate` handler (wrapped in try/catch → logger): skip `msg.author.bot`; call `processDiscordEvent(adapter, payload, { ownerId, ownerUserId, botUserId })`.
  - `guildMemberAdd` handler: if an introductions/welcome channel is configured, `adapter.sendText(welcomeChannelId, buildWelcomeMessage(...))` (best-effort).
  - `ready`: capture `client.user.id` as `botUserId`.
  - `stop()`: `await client.destroy()`.
- [ ] **Step 4: Run → PASS + full check** (verify `discord.js` doesn't drag dev-only bloat into the pruned prod image — check `npm ci --omit=dev && ls node_modules/discord.js` still present, and no `typescript`-style leak; if `npm run check` includes audit:deps, ensure it passes).
- [ ] **Step 5: Commit** `feat(discord): real Gateway client (discord.js) feeding the pipeline`

---

## Task 6: Discord scheduler binders

**Files:**
- Create: `src/platforms/discord/schedulers.ts`
- Test: `tests/discord-schedulers.test.ts`

**Interfaces:**
- Consumes: pure builders `buildWeeklyRecap()` (features/recap.ts), `formatDigest(stats)`+`snapshotAndReset()` (features/digest.ts + middleware/stats.ts), `listPendingEventReminders`/`markEventReminderSent` (features/event-reminders logic via db), a `PlatformMessenger`, and target channel ids.
- Produces: `scheduleDiscordDigest(messenger, targetChannelId): () => void`, `scheduleDiscordWeeklyRecap(messenger, targetChannelId): () => void`, `scheduleDiscordEventReminders(messenger): () => void` — each returns a disposer (clears its timer), mirroring the WhatsApp scheduler signatures but sending via `messenger.sendText` instead of `sock.sendMessage`. Do NOT import Baileys.

- [ ] **Step 1: Write the failing test** — use fake timers (`vi.useFakeTimers`) + a demo/mock messenger; mock the pure builders to return known text; assert that advancing to the scheduled time calls `messenger.sendText(targetChannelId, <text>)`, and that the returned disposer clears the timer (no send after dispose). For event reminders, mock `listPendingEventReminders` to return one due reminder and assert it's sent to its `chatJid` and marked sent.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** by mirroring `whatsapp/digest.ts`/`recap.ts`/`event-reminders.ts` timer logic (read those for the exact scheduling cadence/config flags — `scheduleDigest` daily, `scheduleWeeklyRecap` gated by `WEEKLY_RECAP_ENABLED`, event reminders on an interval) but swapping the send call to the messenger. Reuse the same pure builders they use. Keep each function small.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(discord): scheduler binders (digest/recap/event reminders) via messenger`

---

## Task 7: Runtime rework (start gateway, bind schedulers, real stop)

**Files:**
- Modify: `src/platforms/discord/runtime.ts`
- Test: `tests/discord-runtime-wiring.test.ts`

**Interfaces:**
- Consumes: `createDiscordGatewayClient` (Task 5), `resolveOwnerDmChannelId` (Task 3), the scheduler binders (Task 6), `getDiscordOwnerId`/digest+recap channel config (Task 2), `createDiscordAdapter`.
- Produces: `createDiscordRuntime(): PlatformRuntime` that, on the Gateway path, starts the client + schedulers and whose `stop()` disposes schedulers and stops the client.

- [ ] **Step 1: Write the failing test** — inject seams (export the runtime with injectable factories, or mock the modules): assert that with `DISCORD_BOT_TOKEN` + `DISCORD_OWNER_ID` set and `DISCORD_GATEWAY_ENABLED=true`, `start()` resolves the owner DM channel, starts the gateway client, and registers the three schedulers; `stop()` calls the client's stop + each scheduler disposer. With `DISCORD_GATEWAY_ENABLED=false`, it falls back to the interactions server (existing behavior). Missing `DISCORD_OWNER_ID` on the gateway path logs fatal + throws (mirror existing runtime fatal).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**
  - Gateway path (token present && `DISCORD_GATEWAY_ENABLED`): build adapter; `const ownerUserId = getDiscordOwnerId()` (throw fatal if absent); `const ownerDmChannelId = await resolveOwnerDmChannelId(token, ownerUserId) ?? ownerUserId`; create + `start()` the gateway client (pass `ownerId: ownerDmChannelId`, `ownerUserId`); push scheduler disposers (`scheduleDiscordDigest(adapter, DISCORD_DIGEST_CHANNEL_ID ?? ownerDmChannelId)`, weekly recap if `WEEKLY_RECAP_ENABLED` → `DISCORD_RECAP_CHANNEL_ID ?? ownerDmChannelId`, event reminders). Track disposers array like the WhatsApp runtime.
  - `stop()`: run disposers, `await client.stop()`.
  - Else if `DISCORD_GATEWAY_ENABLED === false` && interactions keys present → existing interactions server. Else demo mode. Else fatal.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(discord): gateway runtime with bound schedulers + real teardown`

---

## Task 8: Guard WhatsApp bootstrap in index.ts + AGENTS.md

**Files:**
- Modify: `src/index.ts` (login handler wiring ~47-87), `AGENTS.md`
- Test: `tests/index-platform-guard.test.ts` (or assert via a small extracted helper)

**Interfaces:**
- Produces: WhatsApp login bootstrap (`createLoginRequestHandler`, login-URL logging) only runs when `config.MESSAGING_PLATFORM === 'whatsapp'`. Under Discord, `extraHandler` is undefined and no WhatsApp login URLs are logged.

- [ ] **Step 1: Write the failing test** — the cleanest testable seam: extract a pure helper `shouldEnableWhatsAppLogin(platform, loginMode, healthOnlyMode): boolean` and unit-test it (whatsapp+web → true; discord → false). (Full `main()` is hard to test; the helper captures the decision.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the helper, use it to gate both `extraHandler: config.MESSAGING_PLATFORM === 'whatsapp' ? loginHandler : undefined` and the login-URL logging block. Add an `AGENTS.md` Decisions Log entry: "Discord runs a real discord.js Gateway (opt-in channels, `requireMention` default true); owner model uses `DISCORD_OWNER_ID` (user id) + a resolved DM channel for escalation; WhatsApp login bootstrap is whatsapp-only."
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `refactor(index): gate WhatsApp login bootstrap to whatsapp platform`

---

## Task 9: PR

- [ ] **Step 1:** `git push -u origin feat/remy-discord-foundation`
- [ ] **Step 2:** `gh pr create` with a body covering: what this delivers (real Discord Gateway + owner model + config + persona + schedulers), that it's sub-project 0 of Remy, the new `discord.js` dependency, **what the owner must provide** (Discord app + Message Content intent + `DISCORD_OWNER_ID` + `config/discord-channels.json`), test evidence, and that it's stacked (band sub-projects branch off this). Do NOT merge. Update the PR description on every push.

---

## Self-Review

**Spec coverage:** Gateway (T5) ✓; owner model — resolution (T3) + gating (T4) + runtime wiring (T7) ✓; per-channel/role config (T2) ✓; persona + formatting (T1) ✓; bound schedulers + welcome + lifecycle (T6, T7; welcome in T5) ✓; index guard (T8) ✓; no-band-features ✓; no-WhatsApp-regression (binders reuse pure builders, WhatsApp untouched) ✓; tests mock discord.js (T5) ✓.

**Placeholder scan:** T4's `handleIntroduction`/`handleEventPassive` wiring says "wire to the same feature entry points the WhatsApp handler uses" — the implementer must read the WhatsApp handler to find them; this is a named-file directive, not a vague TODO. T1's persona doc content is described, not templated, intentionally (prose artifact).

**Type consistency:** `env = { ownerId, ownerUserId?, botUserId? }` consistent across T4/T5/T7. `resolveOwnerDmChannelId`, `createDiscordGatewayClient`, scheduler binder names, and Task 2 predicate names are used verbatim in their consumers.

**Scope:** One coherent theme (make Discord real). Large but single-plan; no band features leak in.
