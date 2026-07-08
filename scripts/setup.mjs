#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execSync } from 'node:child_process';

import {
  DISCORD_FIELDS,
  WHATSAPP_FIELDS,
  TELEGRAM_FIELDS,
  MATRIX_FIELDS,
  getField,
  promptHint,
  resolveEnvField,
  resolveMessagingPlatform,
  mergeExistingEnvForPlatform,
  generateMonitoringToken,
  resolveComposeProfiles,
  buildPlatformEnvLines,
  buildSharedEnvLines,
  mergeEnvFileContent,
  redactEnvContent,
  OPENAI_AUTH_MODES,
  WHATSAPP_LOGIN_MODES,
} from './setup-fields.mjs';

// fileURLToPath (not `new URL(...).pathname`) so root resolution is
// Windows-safe: pathname leaves a leading slash on drive-letter paths
// (`/C:/repo/...`) that fs calls then choke on.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const PACKAGE_JSON_PATH = resolve(PROJECT_ROOT, 'package.json');

// GARBANZO_CLI=1 marks a run spawned by the packaged `garbanzo` CLI binary
// (src/cli.ts's `setup` subcommand spawns this script — set by T6 packaging).
// Repo-mode runs (`npm run setup`) never set it.
const IS_PACKAGED_RUN = process.env.GARBANZO_CLI === '1';

// Everything the wizard *writes* (.env*, config/*.json, docs/PERSONA.md
// overrides) lands under GARBANZO_HOME when it's set, mirroring homePath() in
// src/utils/paths.ts without importing src/ (this script must stay
// import-isolated from the runtime config graph). Falls back to the repo
// root, byte-identical to prior behavior.
const GARBANZO_HOME_ENV = (process.env.GARBANZO_HOME ?? '').trim();
const OUTPUT_ROOT = GARBANZO_HOME_ENV ? resolve(GARBANZO_HOME_ENV) : PROJECT_ROOT;

const ENV_PATH = resolve(OUTPUT_ROOT, '.env');
const ENV_DISCORD_PATH = resolve(OUTPUT_ROOT, '.env.discord');
const ENV_WHATSAPP_PATH = resolve(OUTPUT_ROOT, '.env.whatsapp');
const ENV_TELEGRAM_PATH = resolve(OUTPUT_ROOT, '.env.telegram');
const ENV_MATRIX_PATH = resolve(OUTPUT_ROOT, '.env.matrix');
const GROUPS_PATH = resolve(OUTPUT_ROOT, 'config', 'groups.json');
const DISCORD_CHANNELS_PATH = resolve(OUTPUT_ROOT, 'config', 'discord-channels.json');
const TELEGRAM_CHATS_PATH = resolve(OUTPUT_ROOT, 'config', 'telegram-chats.json');
const MATRIX_ROOMS_PATH = resolve(OUTPUT_ROOT, 'config', 'matrix-rooms.json');
const PERSONA_PATH = resolve(OUTPUT_ROOT, 'docs', 'PERSONA.md');

// Discord walkthrough copy is cross-checked against what the runtime actually
// does, so instructions never promise more than the bot needs:
//   Gateway intents requested (src/platforms/discord/gateway-client.ts:274-278):
//   Guilds, GuildMessages, MessageContent, GuildMembers, GuildMessageReactions.
//   Of those, only GuildMembers ("Server Members Intent") and MessageContent
//   ("Message Content Intent") are *privileged* and must be toggled on in the
//   Developer Portal's Bot page — Guilds/GuildMessages/GuildMessageReactions
//   need no toggle.
const DISCORD_PRIVILEGED_INTENTS = ['Server Members Intent', 'Message Content Intent'];

// Invite permission bits, derived from what src/platforms/discord/adapter.ts
// actually calls:
//   View Channel          0x000400 (1024)   — see the channel to read/post
//   Send Messages         0x000800 (2048)   — sendText/sendTextWithRef/sendPoll
//   Attach Files          0x008000 (32768)  — sendDocument/sendAudio (multipart)
//   Read Message History  0x010000 (65536)  — message_reference replies
// Nothing else: adapter.ts never posts embeds, never calls the reactions
// endpoint (sendAcknowledgmentReaction is a no-op for Discord today —
// src/platforms/discord/processor.ts:151), and never creates threads.
const DISCORD_INVITE_PERMISSIONS = 1024 + 2048 + 32768 + 65536; // 101376

function buildDiscordInviteUrl(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot&permissions=${DISCORD_INVITE_PERMISSIONS}`;
}

// Discord snowflake IDs (channel/user/application IDs) are 17-20 digit
// numbers. Free-text values like '#general' or a channel *name* are silently
// ignored by the runtime (adapter/gateway-client look up by numeric ID), so
// the wizard validates the shape here rather than letting a bad value
// through to a config file the bot will quietly ignore.
const SNOWFLAKE_RE = /^\d{17,20}$/;
function isSnowflake(value) {
  return SNOWFLAKE_RE.test(String(value ?? '').trim());
}
const SNOWFLAKE_HINT = 'a Discord snowflake ID is 17-20 digits, numbers only — enable Developer '
  + 'Mode (User Settings -> Advanced), then right-click the channel/user/application and choose "Copy ID"';

// Telegram chat/user ids are plain (not snowflake-shaped) integers. Accept
// positive ids, legacy negative group ids, and -100-prefixed supergroup/channel
// ids, but reject zero, incomplete -100, leading-zero forms, and values far
// beyond Telegram's current id sizes.
const TELEGRAM_CHAT_ID_RE = /^-?[1-9]\d*$/;
function isTelegramChatId(value) {
  const normalized = String(value ?? '').trim();
  if (!TELEGRAM_CHAT_ID_RE.test(normalized)) return false;
  if (normalized === '-100') return false;
  return normalized.replace(/^-/, '').length <= 16;
}
const TELEGRAM_CHAT_ID_HINT = 'a Telegram chat ID is numeric — groups are negative, and supergroups/'
  + 'channels are negative with a -100 prefix (e.g. -1001234567890); do not use 0, leading zeros, '
  + 'bare -100, or ids longer than 16 digits; add the bot to the chat, send a '
  + 'message, then read the id off @userinfobot (forward the message to it) or the getUpdates response '
  + '(https://api.telegram.org/bot<token>/getUpdates)';
const TELEGRAM_USER_ID_HINT = 'a Telegram user id is numeric digits only — get it from @userinfobot';

// Matrix identifiers: user ids are @localpart:server, room ids are
// !opaque:server, and room ALIASES are #alias:server. The rooms config is
// keyed by room ID only — aliases are resolved to ids at wizard time via the
// homeserver's directory API, because aliases can be repointed while ids are
// permanent.
const MATRIX_USER_ID_RE = /^@[^:\s]+:[^\s]+$/;
const MATRIX_ROOM_ID_RE = /^![^:\s]+:[^\s]+$/;
const MATRIX_ROOM_ALIAS_RE = /^#[^:\s]+:[^\s]+$/;
const MATRIX_OWNER_ID_HINT = 'a Matrix user id (shaped like @you:example.org)';
const MATRIX_ROOM_HINT = 'a Matrix room id looks like !abc123:example.org (Element: Room Settings -> Advanced -> '
  + 'Internal room ID); a published alias like #community:example.org also works and is resolved to the id';

let DEFAULT_APP_VERSION = '0.1.0';
try {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
  if (typeof pkg.version === 'string' && pkg.version.trim()) {
    DEFAULT_APP_VERSION = pkg.version.trim();
  }
} catch {
  // fallback is fine
}

const FEATURE_PROFILES = {
  full: {
    label: 'Full Community',
    description: 'Weather, transit, events, moderation, multimedia, D&D, books, fun.',
    features: ['weather', 'transit', 'news', 'events', 'dnd', 'roll', 'books', 'venues', 'poll', 'fun', 'character', 'feedback', 'profile', 'summary', 'recommend', 'voice'],
    persona: 'Friendly community assistant. Help with logistics, planning, and conversation.',
  },
  lightweight: {
    label: 'Lightweight Chat',
    description: 'Core chat help + summaries + feedback; no hobby-heavy features.',
    features: ['help', 'feedback', 'summary', 'profile'],
    persona: 'Concise, helpful assistant focused on quick answers and group context.',
  },
  events: {
    label: 'Events Heavy',
    description: 'Meetup logistics and planning first.',
    features: ['weather', 'transit', 'news', 'events', 'venues', 'poll', 'summary', 'recommend', 'feedback'],
    persona: 'Structured planner. Prioritize dates, locations, weather, and transportation.',
  },
  dnd: {
    label: 'D&D Focused',
    description: 'Dice, lookups, and character creation focused.',
    features: ['dnd', 'roll', 'character', 'summary', 'feedback', 'fun'],
    persona: 'Tabletop-savvy assistant. Keep rules clear and practical.',
  },
  bookclub: {
    label: 'Book Club',
    description: 'Books, recaps, and venue suggestions for discussion nights.',
    features: ['books', 'news', 'venues', 'events', 'summary', 'profile', 'recommend', 'feedback'],
    persona: 'Thoughtful and literary. Encourage discussion and accessible recommendations.',
  },
};

const PROVIDER_LABELS = {
  openrouter: 'OpenRouter Claude',
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  bedrock: 'AWS Bedrock',
};

// Persona gallery (WS10): six shipped personas alongside the Garbanzo Bean
// default, each a working demonstration of a real feature set. Files live in
// docs/personas/gallery/ (a subdirectory — docs/personas/*.md filenames are
// PLATFORM KEYS the loader resolves by MESSAGING_PLATFORM, so gallery names
// must not share that namespace). `key` is matched case-insensitively
// against --persona=<name> and the interactive picker.
const GALLERY_DIR = resolve(PROJECT_ROOT, 'docs', 'personas', 'gallery');
const PERSONA_GALLERY = [
  {
    key: 'riff',
    file: 'riff.md',
    label: 'Riff 🎸',
    useCase: 'Bands and music projects — songs, rehearsals, setlists, idea capture (needs BAND_FEATURES_ENABLED).',
    bandFeatures: true,
  },
  {
    key: 'quill',
    file: 'quill.md',
    label: 'Quill 🎲',
    useCase: 'Tabletop groups — memory-as-canon, session recaps, scheduling, the character sheet generator.',
  },
  {
    key: 'margie',
    file: 'margie.md',
    label: 'Margie 📚',
    useCase: 'Book clubs — book lookups, reading schedule, spoiler-aware moderation.',
  },
  {
    key: 'bea',
    file: 'bea.md',
    label: 'Bea 🏡',
    useCase: 'Neighborhood and mutual-aid groups — welcomes, events, weather, practical community memory.',
  },
  {
    key: 'patch',
    file: 'patch.md',
    label: 'Patch 🔧',
    useCase: 'Open-source and maker communities — contributor welcomes, decision memory, weekly recaps, CoC moderation.',
  },
  {
    key: 'callie',
    file: 'callie.md',
    label: 'Callie 🎭',
    useCase: 'Theater, dance, and rehearsal-based groups — rehearsal calls, availability, run order (needs BAND_FEATURES_ENABLED).',
    bandFeatures: true,
  },
];

function findGalleryEntry(name) {
  const normalized = name.trim().toLowerCase();
  return PERSONA_GALLERY.find((entry) => entry.key === normalized);
}

/**
 * Resolves a --persona=<gallery-name|path> value (or the interactive
 * picker's "custom path" answer) to { content, sourcePath, galleryEntry }.
 * Gallery names are matched case-insensitively first; anything else is
 * treated as a file path (absolute or relative to the project root),
 * mirroring resolveUserPath()'s existing --persona-file behavior. Throws
 * with the list of valid gallery names when neither resolves — the wizard's
 * usual clear-error-over-silent-fallback convention.
 */
function resolvePersonaSelection(value) {
  const trimmed = (value || '').trim();
  const galleryEntry = trimmed ? findGalleryEntry(trimmed) : undefined;
  if (galleryEntry) {
    const filePath = resolve(GALLERY_DIR, galleryEntry.file);
    return { content: readFileSync(filePath, 'utf-8'), sourcePath: filePath, galleryEntry };
  }

  const asPath = trimmed ? resolveUserPath(trimmed) : '';
  if (asPath && existsSync(asPath)) {
    const content = readFileSync(asPath, 'utf-8');
    if (!content.trim()) {
      throw new Error(`Persona file is empty: ${asPath}`);
    }
    return { content, sourcePath: asPath, galleryEntry: null };
  }

  const names = PERSONA_GALLERY.map((entry) => entry.key).join(', ');
  throw new Error(
    `Unknown persona "${value}" — not a gallery name (available: ${names}) and not a file that exists.`,
  );
}

const ALL_FEATURES = [
  'weather', 'transit', 'news', 'help', 'events', 'dnd', 'roll',
  'books', 'venues', 'poll', 'fun', 'character', 'feedback',
  'profile', 'summary', 'recommend', 'voice',
];

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf-8').split('\n');
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function resolveUserPath(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return trimmed;
  return resolve(PROJECT_ROOT, trimmed);
}

function parseArgs(argv) {
  const options = {};
  const flags = new Set();

  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) {
      flags.add(body);
      continue;
    }
    const key = body.slice(0, eq);
    const value = body.slice(eq + 1);
    options[key] = value;
  }

  return { options, flags };
}

function parseCsv(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mergeEnvTargetContent(path, generatedContent) {
  if (!existsSync(path)) return generatedContent;
  return mergeEnvFileContent(readFileSync(path, 'utf-8'), generatedContent);
}

function sanitizeFeatureList(features) {
  const normalized = Array.from(new Set(features.map((f) => f.trim().toLowerCase()).filter(Boolean)));
  const invalid = normalized.filter((f) => !ALL_FEATURES.includes(f));
  if (invalid.length > 0) {
    throw new Error(`Invalid features: ${invalid.join(', ')}. Valid: ${ALL_FEATURES.join(', ')}`);
  }
  return normalized;
}

function yn(value, fallback = true) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['y', 'yes'].includes(normalized)) return true;
  if (['n', 'no'].includes(normalized)) return false;
  return fallback;
}

function defaultQdrantCollectionForBand(isBandDeployment, existingCollection) {
  const current = (existingCollection || '').trim();
  if (isBandDeployment && (!current || current === 'garbanzo_memory')) return 'remy_memory';
  return current || 'garbanzo_memory';
}

async function promptChoice(rl, question, options, defaultIndex = 0) {
  output.write(`\n${question}\n`);
  options.forEach((option, index) => {
    const marker = index === defaultIndex ? '*' : ' ';
    output.write(`  ${index + 1}) ${option} ${marker}\n`);
  });
  const answer = await rl.question(`Select [${defaultIndex + 1}]: `);
  const picked = Number.parseInt(answer.trim(), 10);
  if (Number.isNaN(picked) || picked < 1 || picked > options.length) {
    return defaultIndex;
  }
  return picked - 1;
}

// Interactive re-prompt loop for a FIELD_TABLE field that must resolve to a
// non-empty (and optionally validated) value. Blank input falls back to the
// existing .env value (the wizard's usual "keep current value" convention);
// only a genuinely empty *resolved* value triggers a re-prompt, so re-runs
// against a populated .env don't force retyping secrets/IDs that are already
// set.
async function promptRequiredField(rl, field, existing, { validate, invalidHint } = {}) {
  const label = field.note ? `${field.env} ${field.note}` : field.env;
  while (true) {
    const raw = (await rl.question(`${label} [${promptHint(field, existing)}]: `)).trim();
    const value = raw || (existing[field.env] || '').trim();
    if (!value) {
      output.write(`   ⚠️ ${field.env} is required.\n`);
      continue;
    }
    if (validate && !validate(value)) {
      output.write(`   ⚠️ "${value}" doesn't look like ${invalidHint || 'a valid value'}.\n`);
      continue;
    }
    return value;
  }
}

// Collects one { id, name } channel entry interactively, re-prompting on
// empty/invalid input until a valid snowflake is given.
async function promptChannelEntry(rl) {
  let channelId = '';
  while (!channelId) {
    const answer = (await rl.question('   Channel ID to enable: ')).trim();
    if (!answer) {
      output.write('   ⚠️ A channel ID is required — the quickstart cannot finish with zero enabled channels.\n');
      continue;
    }
    if (!isSnowflake(answer)) {
      output.write(`   ⚠️ "${answer}" doesn't look like a Discord channel ID — ${SNOWFLAKE_HINT}.\n`);
      continue;
    }
    channelId = answer;
  }
  const channelName = (await rl.question('   Channel name/label [general]: ')).trim() || 'general';
  return { id: channelId, name: channelName };
}

// Resolves the full set of enabled Discord channels for this run (M1/H3):
//   - Reads any existing config/discord-channels.json.
//   - Merges in --discord-channel-id(s) from this run rather than silently
//     discarding them when a file already exists.
//   - Guarantees the quickstart can never finish with zero enabled channels,
//     even when an existing file's channels are all disabled: non-interactive
//     fails with a clear message, interactive re-prompts as if the file were
//     absent (merging the new entry into the existing map).
// Returns { channelsMap, changed, ownerId } — `changed` tells the caller
// whether config/discord-channels.json needs to be (re)written at all; when
// false the existing file is left completely untouched.
async function resolveDiscordChannels({ nonInteractive, cli, rl }) {
  let existingConfig = null;
  if (existsSync(DISCORD_CHANNELS_PATH)) {
    try {
      existingConfig = JSON.parse(readFileSync(DISCORD_CHANNELS_PATH, 'utf-8'));
    } catch (err) {
      throw new Error(`config/discord-channels.json exists but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const channelsMap = { ...(existingConfig?.channels ?? {}) };
  let changed = false;

  const explicitIds = parseCsv(cli.options['discord-channel-id'] ?? cli.options['discord-channel-ids'] ?? '');
  const invalidIds = explicitIds.filter((id) => !isSnowflake(id));
  if (invalidIds.length > 0) {
    throw new Error(
      `--discord-channel-id(s) contains a value that doesn't look like a Discord channel ID (${SNOWFLAKE_HINT}): `
      + invalidIds.map((id) => `"${id}"`).join(', '),
    );
  }
  if (explicitIds.length > 0) {
    // Object keys naturally dedupe repeated ids from --discord-channel-ids.
    const explicitName = (cli.options['discord-channel-name'] || 'general').trim() || 'general';
    for (const id of explicitIds) {
      channelsMap[id] = { name: explicitName, enabled: true, requireMention: true };
    }
    changed = true;
  }

  const countEnabled = () => Object.values(channelsMap).filter((entry) => entry && entry.enabled).length;

  if (countEnabled() === 0) {
    if (nonInteractive) {
      throw new Error(
        'Discord quickstart requires at least one channel to enable — the bot ignores every ' +
        'channel until one is enabled. Pass --discord-channel-id=<channel id> (enable Developer Mode, ' +
        'right-click the channel, "Copy Channel ID") or run interactively.',
      );
    }
    if (existingConfig) {
      output.write('\n⚠️ config/discord-channels.json exists but has zero enabled channels — the quickstart cannot finish like that.\n');
    }
    output.write('\n5) At least one channel to enable: with Developer Mode on, right-click a channel\n');
    output.write('   in your server and choose "Copy Channel ID". The bot ignores every channel until\n');
    output.write('   one is enabled here — you can add more later by editing config/discord-channels.json\n');
    output.write('   (schema: config/discord-channels.example.json).\n');
    const entry = await promptChannelEntry(rl);
    channelsMap[entry.id] = { name: entry.name, enabled: true, requireMention: true };
    changed = true;
  }

  return { channelsMap, changed, ownerId: existingConfig?.ownerId, existingConfig };
}

// Collects one { id, name } chat entry interactively, re-prompting on
// empty/invalid input until a valid Telegram chat id is given. Mirrors
// promptChannelEntry() for Discord.
async function promptTelegramChatEntry(rl) {
  let chatId = '';
  while (!chatId) {
    const answer = (await rl.question('   Chat ID to enable: ')).trim();
    if (!answer) {
      output.write('   ⚠️ A chat ID is required — the quickstart cannot finish with zero enabled chats.\n');
      continue;
    }
    if (!isTelegramChatId(answer)) {
      output.write(`   ⚠️ "${answer}" doesn't look like a Telegram chat ID — ${TELEGRAM_CHAT_ID_HINT}.\n`);
      continue;
    }
    chatId = answer;
  }
  const chatName = (await rl.question('   Chat name/label [general]: ')).trim() || 'general';
  return { id: chatId, name: chatName };
}

// Resolves the full set of enabled Telegram chats for this run, mirroring
// resolveDiscordChannels() exactly (same merge/gate/re-prompt contract, one
// enabled chat required to finish the quickstart) against
// config/telegram-chats.json's { ownerId, chats } shape instead of
// discord-channels.json's { ownerId, channels }.
async function resolveTelegramChats({ nonInteractive, cli, rl }) {
  let existingConfig = null;
  if (existsSync(TELEGRAM_CHATS_PATH)) {
    try {
      existingConfig = JSON.parse(readFileSync(TELEGRAM_CHATS_PATH, 'utf-8'));
    } catch (err) {
      throw new Error(`config/telegram-chats.json exists but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const chatsMap = { ...(existingConfig?.chats ?? {}) };
  let changed = false;

  const explicitIds = parseCsv(cli.options['telegram-chat-id'] ?? cli.options['telegram-chat-ids'] ?? '');
  const invalidIds = explicitIds.filter((id) => !isTelegramChatId(id));
  if (invalidIds.length > 0) {
    throw new Error(
      `--telegram-chat-id(s) contains a value that doesn't look like a Telegram chat ID (${TELEGRAM_CHAT_ID_HINT}): `
      + invalidIds.map((id) => `"${id}"`).join(', '),
    );
  }
  if (explicitIds.length > 0) {
    // Object keys naturally dedupe repeated ids from --telegram-chat-ids.
    const explicitName = (cli.options['telegram-chat-name'] || 'general').trim() || 'general';
    for (const id of explicitIds) {
      chatsMap[id] = { name: explicitName, enabled: true, requireMention: true };
    }
    changed = true;
  }

  const countEnabled = () => Object.values(chatsMap).filter((entry) => entry && entry.enabled).length;

  if (countEnabled() === 0) {
    if (nonInteractive) {
      throw new Error(
        'Telegram quickstart requires at least one chat to enable — the bot ignores every ' +
        'chat until one is enabled. Pass --telegram-chat-id=<chat id> (add the bot to the chat, send a ' +
        "message, then read the id off @userinfobot or the bot's getUpdates response) or run interactively.",
      );
    }
    if (existingConfig) {
      output.write('\n⚠️ config/telegram-chats.json exists but has zero enabled chats — the quickstart cannot finish like that.\n');
    }
    output.write('\n4) At least one chat to enable: add the bot to the group, send a message, then read\n');
    output.write('   the chat id off @userinfobot (forward the group message to it) or from\n');
    output.write('   https://api.telegram.org/bot<token>/getUpdates ("chat":{"id":...}). Group ids are\n');
    output.write('   negative; supergroup/channel ids are negative with a -100 prefix. The bot ignores\n');
    output.write('   every chat until one is enabled here — add more later by editing\n');
    output.write('   config/telegram-chats.json (schema: config/telegram-chats.example.json).\n');
    const entry = await promptTelegramChatEntry(rl);
    chatsMap[entry.id] = { name: entry.name, enabled: true, requireMention: true };
    changed = true;
  }

  return { chatsMap, changed, ownerId: existingConfig?.ownerId, existingConfig };
}

// Resolves a #alias:server to its permanent !room:server id via the
// homeserver's public directory endpoint. Requires a reachable homeserver;
// dry-runs and offline tests should pass room ids directly.
async function resolveMatrixRoomAlias(homeserverUrl, alias) {
  const base = homeserverUrl.replace(/\/+$/, '');
  const url = `${base}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`;
  let response;
  try {
    // Bound the wait — a header-stalling host would otherwise hang the
    // wizard for undici's default (~300s) before the plain fetch failure
    // ever surfaces.
    response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const causeCode = err instanceof Error && err.cause && typeof err.cause === 'object' && 'code' in err.cause
      ? ` (${String(err.cause.code)})`
      : '';
    throw new Error(`Could not reach ${base} to resolve ${alias}: ${message}${causeCode}`);
  }
  if (!response.ok) {
    throw new Error(`Homeserver could not resolve ${alias} (HTTP ${response.status}) — is the alias published?`);
  }
  const body = await response.json();
  const roomId = typeof body?.room_id === 'string' ? body.room_id : '';
  if (!MATRIX_ROOM_ID_RE.test(roomId)) {
    throw new Error(`Homeserver returned an unexpected id for ${alias}: "${roomId}"`);
  }
  return roomId;
}

// Collects one { id, name } room entry interactively, resolving aliases and
// re-prompting on invalid input. Mirrors promptTelegramChatEntry().
async function promptMatrixRoomEntry(rl, homeserverUrl, { dryRun }) {
  for (;;) {
    const answer = (await rl.question('   Room ID (or #alias) to enable: ')).trim();
    if (!answer) {
      output.write('   ⚠️ A room is required — the quickstart cannot finish with zero enabled rooms.\n');
      continue;
    }
    let roomId = answer;
    if (MATRIX_ROOM_ALIAS_RE.test(answer)) {
      if (dryRun) {
        output.write('   ⚠️ Dry-run cannot resolve aliases (needs the homeserver) — enter the room ID directly.\n');
        continue;
      }
      try {
        roomId = await resolveMatrixRoomAlias(homeserverUrl, answer);
        output.write(`   ↳ ${answer} resolved to ${roomId}\n`);
      } catch (err) {
        output.write(`   ⚠️ ${err instanceof Error ? err.message : String(err)}\n`);
        continue;
      }
    } else if (!MATRIX_ROOM_ID_RE.test(answer)) {
      output.write(`   ⚠️ "${answer}" doesn't look like a Matrix room — ${MATRIX_ROOM_HINT}.\n`);
      continue;
    }
    const roomName = (await rl.question('   Room name/label [general]: ')).trim() || 'general';
    return { id: roomId, name: roomName };
  }
}

// Resolves the full set of enabled Matrix rooms for this run, mirroring
// resolveTelegramChats() (merge/gate/re-prompt contract, one enabled room
// required) against config/matrix-rooms.json's { ownerId, rooms } shape.
async function resolveMatrixRooms({ nonInteractive, cli, rl, homeserverUrl, dryRun }) {
  let existingConfig = null;
  if (existsSync(MATRIX_ROOMS_PATH)) {
    try {
      existingConfig = JSON.parse(readFileSync(MATRIX_ROOMS_PATH, 'utf-8'));
    } catch (err) {
      throw new Error(`config/matrix-rooms.json exists but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const roomsMap = { ...(existingConfig?.rooms ?? {}) };
  let changed = false;

  const explicitEntries = parseCsv(cli.options['matrix-room-id'] ?? cli.options['matrix-room-ids'] ?? '');
  const invalidEntries = explicitEntries.filter(
    (entry) => !MATRIX_ROOM_ID_RE.test(entry) && !MATRIX_ROOM_ALIAS_RE.test(entry),
  );
  if (invalidEntries.length > 0) {
    throw new Error(
      `--matrix-room-id(s) contains a value that is neither a room id nor an alias (${MATRIX_ROOM_HINT}): `
      + invalidEntries.map((entry) => `"${entry}"`).join(', '),
    );
  }
  if (explicitEntries.length > 0) {
    const explicitName = (cli.options['matrix-room-name'] || 'general').trim() || 'general';
    for (const entry of explicitEntries) {
      let roomId = entry;
      if (MATRIX_ROOM_ALIAS_RE.test(entry)) {
        if (dryRun) {
          throw new Error(`Dry-run cannot resolve the alias ${entry} (needs the homeserver) — pass the room ID directly.`);
        }
        roomId = await resolveMatrixRoomAlias(homeserverUrl, entry);
        output.write(`↳ ${entry} resolved to ${roomId}\n`);
      }
      roomsMap[roomId] = { name: explicitName, enabled: true, requireMention: true };
    }
    changed = true;
  }

  const countEnabled = () => Object.values(roomsMap).filter((entry) => entry && entry.enabled).length;

  if (countEnabled() === 0) {
    if (nonInteractive) {
      throw new Error(
        'Matrix quickstart requires at least one room to enable — the bot ignores every room ' +
        'until one is enabled. Pass --matrix-room-id=<!room:server or #alias:server> or run interactively.',
      );
    }
    if (existingConfig) {
      output.write('\n⚠️ config/matrix-rooms.json exists but has zero enabled rooms — the quickstart cannot finish like that.\n');
    }
    output.write('\n4) At least one room to enable. Invite the bot to the room first (UNENCRYPTED\n');
    output.write('   rooms only — E2EE is not supported), then paste the room id (Element: Room\n');
    output.write('   Settings -> Advanced -> Internal room ID) or a published #alias:server.\n');
    output.write('   Add more later by editing config/matrix-rooms.json (schema:\n');
    output.write('   config/matrix-rooms.example.json).\n');
    const entry = await promptMatrixRoomEntry(rl, homeserverUrl, { dryRun });
    roomsMap[entry.id] = { name: entry.name, enabled: true, requireMention: true };
    changed = true;
  }

  return { roomsMap, changed, ownerId: existingConfig?.ownerId, existingConfig };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const nonInteractive = cli.flags.has('non-interactive');
  const dryRun = cli.flags.has('dry-run');

  if (cli.flags.has('help')) {
    output.write('Garbanzo setup wizard\n\n');
    output.write('Interactive:\n');
    output.write('  npm run setup\n\n');
    output.write('Non-interactive examples:\n');
    output.write('  npm run setup -- --non-interactive --platform=whatsapp --deploy=docker --providers=openrouter,openai --provider-order=openai,openrouter\n');
    output.write('  npm run setup -- --non-interactive --platform=slack --slack-demo=true --providers=openai --openai-key=$OPENAI_API_KEY\n');
    output.write('  npm run setup -- --non-interactive --providers=gemini --gemini-key=$GEMINI_API_KEY --gemini-model=gemini-1.5-flash --gemini-pricing-input-per-m=0.15 --gemini-pricing-output-per-m=0.60\n');
    output.write('  npm run setup -- --non-interactive --profile=events --features=weather,transit,events,venues,poll --group-id=120...@g.us --group-name="Events"\n');
    output.write('  npm run setup -- --non-interactive --persona-file=./my-persona.md --owner-jid=your_number@s.whatsapp.net\n');
    output.write('  npm run setup -- --non-interactive --platform=discord --deploy=native --persona=quill --discord-bot-token=$DISCORD_BOT_TOKEN --discord-owner-id=456... --discord-channel-id=789... --providers=openai --openai-key=$OPENAI_API_KEY\n');
    output.write('  npm run setup -- --non-interactive --app-version=0.2.0 --github-issues-repo=owner/repo --github-issues-token=$GITHUB_ISSUES_TOKEN\n');
    output.write('  npm run setup -- --non-interactive --dry-run --providers=openai --profile=lightweight\n');
    output.write('  npm run setup -- --non-interactive --platform=discord --deploy=native --discord-bot-token=$DISCORD_BOT_TOKEN --discord-client-id=123... --discord-owner-id=456... --discord-channel-id=789... --providers=openai --openai-key=$OPENAI_API_KEY\n');
    output.write('  npm run setup -- --non-interactive --platform=discord --deploy=native --discord-bot-token=$DISCORD_BOT_TOKEN --discord-owner-id=456... --discord-channel-ids=789...,790... --discord-channel-name=general --install-deps=false --vector-store=none --providers=openai --openai-key=$OPENAI_API_KEY\n');
    output.write('  npm run setup -- --non-interactive --platform=telegram --telegram-bot-token=$TELEGRAM_BOT_TOKEN --telegram-owner-id=123456789 --telegram-chat-id=-1001234567890 --providers=openai --openai-key=$OPENAI_API_KEY\n');
    output.write("  npm run setup -- --non-interactive --platform=matrix --matrix-homeserver-url=https://matrix.example.org --matrix-access-token=$MATRIX_ACCESS_TOKEN --matrix-owner-id=@you:example.org --matrix-room-id='!abc:example.org' --providers=openai --openai-key=$OPENAI_API_KEY\n");
    output.write('\nOther non-interactive flags:\n');
    output.write('  --discord-channel-ids   comma-separated Discord channel IDs to enable (alias for --discord-channel-id)\n');
    output.write('  --discord-channel-name  label applied to every channel in --discord-channel-id(s) (default: general)\n');
    output.write('  --telegram-chat-ids     comma-separated Telegram chat IDs to enable (alias for --telegram-chat-id)\n');
    output.write('  --telegram-chat-name    label applied to every chat in --telegram-chat-id(s) (default: general)\n');
    output.write('  --matrix-room-ids       comma-separated Matrix room ids/aliases to enable (alias for --matrix-room-id)\n');
    output.write('  --matrix-room-name      label applied to every room in --matrix-room-id(s) (default: general)\n');
    output.write('  --install-deps          true/false — run `npm install` before writing config (default: true unless GARBANZO_CLI=1)\n');
    output.write('  --vector-store          native deploy target only — VECTOR_STORE value written to .env (default: none)\n');
    output.write(
      `  --persona               gallery name (${PERSONA_GALLERY.map((entry) => entry.key).join(', ')}) or a file path — `
      + 'writes docs/personas/<platform>.md under GARBANZO_HOME (independent of --persona-file, which writes docs/PERSONA.md)\n',
    );
    process.exit(0);
  }

  output.write('🫘 Garbanzo Setup Wizard\n');
  output.write('========================\n');
  if (nonInteractive) {
    output.write('Mode: non-interactive\n');
  }
  if (dryRun) {
    output.write('Mode: dry-run (no files will be written)\n');
  }

  const major = Number.parseInt(process.version.replace(/^v/, '').split('.')[0], 10);
  if (Number.isNaN(major) || major < 20) {
    output.write(`\n❌ Node.js 20+ required (found ${process.version}).\n`);
    process.exit(1);
  }

  if (!dryRun) {
    mkdirSync(OUTPUT_ROOT, { recursive: true });
  }

  const rl = createInterface({ input, output });

  // M3: if stdin hits EOF while a question is still pending (piped-empty
  // stdin, a closed terminal, etc.), the readline/promises `question()`
  // promise never settles — nothing else keeps the event loop alive, so the
  // process exits 0 with no message once the loop drains. `intentionalClose`
  // is set right before *our own* `rl.close()` call in the `finally` below
  // (which covers both the success and the caught-error paths, the latter
  // already reported by main().catch), so this handler only fires for a
  // close we didn't ask for.
  //
  // Only armed in interactive mode: a non-interactive run never legitimately
  // reads stdin, but it does hit other early `await`s (e.g. the Matrix alias
  // fetch in resolveMatrixRoomAlias) that yield the event loop just like a
  // pending question() would. Node treats a closed/absent stdin in
  // non-interactive contexts (CI runners, cron, containers without a TTY) as
  // an incidental 'close' on the readline interface, not user abandonment —
  // arming this handler there killed those runs before they ever touched
  // stdin.
  let intentionalClose = false;
  if (!nonInteractive) {
    rl.on('close', () => {
      if (!intentionalClose) {
        process.stderr.write('Setup aborted before completion\n');
        process.exit(1);
      }
    });
  }

  const rootExisting = parseEnvFile(ENV_PATH);
  let existing = rootExisting;

  // Resolve one FIELD_TABLE field: CLI/existing/default when non-interactive,
  // otherwise prompt with a hint (masked for secret fields — Sec-3).
  const resolveText = async (env) => {
    const field = getField(env);
    if (nonInteractive) return resolveEnvField(field, cli, existing);
    const label = field.note ? `${field.env} ${field.note}` : field.env;
    return rl.question(`${label} [${promptHint(field, existing)}]: `);
  };

  try {
    // Packaged installs (GARBANZO_CLI=1) ship deps already vendored, and the
    // npx cache / global-install prefix may be read-only — never shell out to
    // `npm install` there. Repo-mode is unaffected.
    if (IS_PACKAGED_RUN) {
      output.write('\n📦 Packaged install detected (GARBANZO_CLI=1) — dependencies are already vendored; skipping npm install.\n');
    } else {
      const installDeps = nonInteractive
        ? parseBoolean(cli.options['install-deps'], false)
        : yn(await rl.question('\nInstall dependencies now? [Y/n]: '), true);
      if (installDeps) {
        if (dryRun) {
          output.write('\n🧪 Dry-run: skipping dependency install (npm install)\n');
        } else {
          output.write('\n📦 Installing dependencies...\n');
          execSync('npm install', { cwd: PROJECT_ROOT, stdio: 'inherit' });
        }
      }
    }

    // Discord is the promoted quickstart choice; WhatsApp stays available with
    // its account-risk caveat; Telegram (grammY, long polling) has its own
    // BotFather walkthrough below. Slack is a scaffold path — not offered on
    // the interactive menu, but still reachable non-interactively via
    // --platform=slack (resolveMessagingPlatform below), so the existing
    // Slack dry-run coverage keeps working unchanged. Matrix (matrix-bot-sdk,
    // /sync long polling, unencrypted rooms only) has its own walkthrough
    // below.
    let messagingPlatform = 'discord';
    if (nonInteractive) {
      messagingPlatform = resolveMessagingPlatform(cli, existing);
    } else {
      const platformIndex = await promptChoice(
        rl,
        'Messaging platform:',
        [
          'Discord (recommended — official Gateway API, native quickstart)',
          'WhatsApp (unofficial API — account-risk caveat applies)',
          'Telegram (official Bot API, long polling — grammY)',
          'Matrix (self-hosted homeservers — unencrypted rooms only)',
        ],
        existing.MESSAGING_PLATFORM === 'whatsapp'
          ? 1
          : existing.MESSAGING_PLATFORM === 'telegram'
            ? 2
            : existing.MESSAGING_PLATFORM === 'matrix'
              ? 3
              : 0,
      );
      messagingPlatform = platformIndex === 1
        ? 'whatsapp'
        : platformIndex === 2
          ? 'telegram'
          : platformIndex === 3
            ? 'matrix'
            : 'discord';
    }

    const platformEnvPath = messagingPlatform === 'discord'
      ? ENV_DISCORD_PATH
      : messagingPlatform === 'whatsapp'
        ? ENV_WHATSAPP_PATH
        : messagingPlatform === 'telegram'
          ? ENV_TELEGRAM_PATH
          : messagingPlatform === 'matrix'
            ? ENV_MATRIX_PATH
            : null;
    existing = mergeExistingEnvForPlatform(
      rootExisting,
      platformEnvPath ? parseEnvFile(platformEnvPath) : {},
    );

    if (messagingPlatform === 'whatsapp') {
      output.write(
        '\n⚠️ WhatsApp runs on Baileys, an unofficial WhatsApp Web API — this can carry account risk. ' +
        'The outbound safety layer (rate limits, warm-up) stays on; avoid bulk or spam-like sends.\n',
      );
    }

    let slackDemo = false;
    if (messagingPlatform === 'slack') {
      if (nonInteractive) {
        slackDemo = parseBoolean(cli.options['slack-demo'], parseBoolean(existing.SLACK_DEMO, true));
      } else {
        slackDemo = yn(
          await rl.question('Enable local Slack demo mode? [Y/n] (required for Slack right now): '),
          true,
        );
      }
    }

    const discordEnv = {};
    const whatsappEnv = {};
    const telegramEnv = {};
    const matrixEnv = {};
    let bandDeployment = false;
    let qdrantCollection = existing.QDRANT_COLLECTION || 'garbanzo_memory';
    let discordClientId = '';
    // Populated below by resolveDiscordChannels() once token/owner ID are
    // resolved; { channelsMap, changed, ownerId }.
    let discordChannelsMap = {};
    let discordChannelsChanged = false;
    let existingChannelsOwnerId;
    let existingDiscordChannelsConfig = null;
    if (messagingPlatform === 'discord') {
      if (nonInteractive) {
        discordClientId = (cli.options['discord-client-id'] ?? existing.DISCORD_CLIENT_ID ?? '').trim();
        if (discordClientId && !isSnowflake(discordClientId)) {
          throw new Error(`--discord-client-id "${discordClientId}" doesn't look like a Discord application ID — ${SNOWFLAKE_HINT}.`);
        }
        for (const field of DISCORD_FIELDS.filter((candidate) => candidate.env !== 'BAND_FEATURES_ENABLED')) {
          discordEnv[field.env] = await resolveText(field.env);
        }
        if (!discordEnv.DISCORD_BOT_TOKEN) {
          throw new Error(
            'Discord quickstart requires a bot token — pass --discord-bot-token=<token> ' +
            '(Developer Portal -> Bot page -> Reset Token) or run interactively.',
          );
        }
        if (!discordEnv.DISCORD_OWNER_ID) {
          throw new Error(
            'Discord quickstart requires an owner user ID — pass --discord-owner-id=<id> ' +
            '(enable Developer Mode, right-click your name/avatar, "Copy User ID") or run interactively.',
          );
        }
        if (!isSnowflake(discordEnv.DISCORD_OWNER_ID)) {
          throw new Error(`--discord-owner-id "${discordEnv.DISCORD_OWNER_ID}" doesn't look like a Discord user ID — ${SNOWFLAKE_HINT}.`);
        }
      } else {
        // Portal-order walkthrough (D3): client ID -> bot token (create-app +
        // enable-intents) -> invite URL -> owner user ID -> channel(s) to
        // enable. Optional/advanced fields (public key, gateway toggle, digest/
        // recap channels) come after, unnumbered.
        output.write('\n🤖 Discord quickstart — developer portal walkthrough\n');
        output.write('   https://discord.com/developers/applications\n');

        output.write('\n1) Create (or open) an application at the link above.\n');
        while (true) {
          const answer = (await rl.question(`   Application (client) ID [${existing.DISCORD_CLIENT_ID || 'empty'}]: `)).trim();
          discordClientId = answer || existing.DISCORD_CLIENT_ID || '';
          if (!discordClientId || isSnowflake(discordClientId)) break;
          output.write(`   ⚠️ "${discordClientId}" doesn't look like a Discord application ID — ${SNOWFLAKE_HINT}.\n`);
        }

        output.write('\n2) Open the "Bot" page for that application:\n');
        output.write(`   - Enable: ${DISCORD_PRIVILEGED_INTENTS.join(', ')}.\n`);
        output.write('   - Click "Reset Token" (or "Copy") to get the bot token.\n');
        discordEnv.DISCORD_BOT_TOKEN = await promptRequiredField(rl, getField('DISCORD_BOT_TOKEN'), existing);

        if (discordClientId) {
          output.write('\n3) Invite the bot to your server with this URL:\n');
          output.write(`   ${buildDiscordInviteUrl(discordClientId)}\n`);
        } else {
          output.write('\n3) Skipped invite URL — no application/client ID was provided.\n');
        }

        output.write('\n4) Owner user ID: in Discord, enable Developer Mode (User Settings -> Advanced),\n');
        output.write('   then right-click your own name/avatar and choose "Copy User ID".\n');
        discordEnv.DISCORD_OWNER_ID = await promptRequiredField(rl, getField('DISCORD_OWNER_ID'), existing, {
          validate: isSnowflake,
          invalidHint: `a Discord user ID — ${SNOWFLAKE_HINT}`,
        });

        output.write('\nOptional Discord settings:\n');
        discordEnv.DISCORD_PUBLIC_KEY = await resolveText('DISCORD_PUBLIC_KEY');
        discordEnv.DISCORD_GATEWAY_ENABLED = await resolveText('DISCORD_GATEWAY_ENABLED');
        discordEnv.DISCORD_DIGEST_CHANNEL_ID = await resolveText('DISCORD_DIGEST_CHANNEL_ID');
        discordEnv.DISCORD_RECAP_CHANNEL_ID = await resolveText('DISCORD_RECAP_CHANNEL_ID');
      }

      ({
        channelsMap: discordChannelsMap,
        changed: discordChannelsChanged,
        ownerId: existingChannelsOwnerId,
        existingConfig: existingDiscordChannelsConfig,
      } = await resolveDiscordChannels({ nonInteractive, cli, rl }));

      if (nonInteractive) {
        const bandValue = resolveEnvField(getField('BAND_FEATURES_ENABLED'), cli, existing);
        bandDeployment = parseBoolean(bandValue, false);
      } else {
        const existingBandDeployment = parseBoolean(existing.BAND_FEATURES_ENABLED, false);
        bandDeployment = yn(
          await rl.question(`\nIs this a band deployment (Remy)? [${existingBandDeployment ? 'Y/n' : 'y/N'}]: `),
          existingBandDeployment,
        );
      }
      discordEnv.BAND_FEATURES_ENABLED = String(bandDeployment);

      const qdrantDefault = defaultQdrantCollectionForBand(bandDeployment, existing.QDRANT_COLLECTION);
      qdrantCollection = nonInteractive
        ? (cli.options['qdrant-collection'] ?? qdrantDefault)
        : ((await rl.question(`QDRANT_COLLECTION [${qdrantDefault}]: `)).trim() || qdrantDefault);
    }

    // Populated below by resolveTelegramChats() once token/owner ID are
    // resolved; { chatsMap, changed, ownerId }.
    let telegramChatsMap = {};
    let telegramChatsChanged = false;
    let existingTelegramChatsOwnerId;
    let existingTelegramChatsConfig = null;
    if (messagingPlatform === 'telegram') {
      if (nonInteractive) {
        for (const field of TELEGRAM_FIELDS) {
          telegramEnv[field.env] = await resolveText(field.env);
        }
        if (!telegramEnv.TELEGRAM_BOT_TOKEN) {
          throw new Error(
            'Telegram quickstart requires a bot token — pass --telegram-bot-token=<token> ' +
            '(message @BotFather, run /newbot) or run interactively.',
          );
        }
        if (!telegramEnv.TELEGRAM_OWNER_ID) {
          throw new Error(
            'Telegram quickstart requires an owner user ID — pass --telegram-owner-id=<id> ' +
            '(message @userinfobot) or run interactively.',
          );
        }
        if (!/^\d+$/.test(telegramEnv.TELEGRAM_OWNER_ID)) {
          throw new Error(`--telegram-owner-id "${telegramEnv.TELEGRAM_OWNER_ID}" doesn't look like ${TELEGRAM_USER_ID_HINT}.`);
        }
      } else {
        // BotFather walkthrough: create bot -> copy token -> disable privacy
        // mode (the recommended setup, explained inline) -> owner user id ->
        // chat(s) to enable (below, via resolveTelegramChats).
        output.write('\n📮 Telegram quickstart — BotFather walkthrough\n');
        output.write('   https://t.me/BotFather\n');

        output.write('\n1) Message @BotFather and run /newbot; follow its prompts to create the bot,\n');
        output.write('   then copy the token it gives you.\n');
        telegramEnv.TELEGRAM_BOT_TOKEN = await promptRequiredField(rl, getField('TELEGRAM_BOT_TOKEN'), existing);

        output.write('\n2) Message @BotFather again, run /setprivacy, choose this bot, then choose\n');
        output.write('   Disable. Telegram never delivers plain-text messages (including @mentions)\n');
        output.write('   to a privacy-ON bot, so this is the recommended setup — the bot still only\n');
        output.write('   RESPONDS on @mentions/replies/!commands via requireMention (config/telegram-chats.json),\n');
        output.write('   same as Discord\'s MessageContent + requireMention. This is a manual BotFather\n');
        output.write('   step; the wizard cannot toggle it for you.\n');

        output.write('\n3) Owner user id: message @userinfobot from your own account — it replies with\n');
        output.write('   your numeric Telegram user id.\n');
        telegramEnv.TELEGRAM_OWNER_ID = await promptRequiredField(rl, getField('TELEGRAM_OWNER_ID'), existing, {
          validate: (value) => /^\d+$/.test(value),
          invalidHint: TELEGRAM_USER_ID_HINT,
        });

        output.write('\nOptional Telegram settings:\n');
        telegramEnv.TELEGRAM_CHAT_SCOPE = await resolveText('TELEGRAM_CHAT_SCOPE');
      }

      ({
        chatsMap: telegramChatsMap,
        changed: telegramChatsChanged,
        ownerId: existingTelegramChatsOwnerId,
        existingConfig: existingTelegramChatsConfig,
      } = await resolveTelegramChats({ nonInteractive, cli, rl }));
    }

    // Populated below by resolveMatrixRooms(); { roomsMap, changed, ownerId }.
    let matrixRoomsMap = {};
    let matrixRoomsChanged = false;
    let existingMatrixRoomsOwnerId;
    let existingMatrixRoomsConfig = null;
    if (messagingPlatform === 'matrix') {
      if (nonInteractive) {
        for (const field of MATRIX_FIELDS) {
          matrixEnv[field.env] = await resolveText(field.env);
        }
        if (!matrixEnv.MATRIX_HOMESERVER_URL) {
          throw new Error(
            'Matrix quickstart requires a homeserver URL — pass --matrix-homeserver-url=https://matrix.example.org or run interactively.',
          );
        }
        if (!/^https?:\/\//.test(matrixEnv.MATRIX_HOMESERVER_URL)) {
          throw new Error(
            `--matrix-homeserver-url "${matrixEnv.MATRIX_HOMESERVER_URL}" doesn't look like a homeserver URL — ` +
            'it must start with https:// (or http:// on a trusted LAN), e.g. https://matrix.example.org.',
          );
        }
        if (!matrixEnv.MATRIX_ACCESS_TOKEN) {
          throw new Error(
            'Matrix quickstart requires a bot access token — create a bot account on your homeserver and pass --matrix-access-token=<token> or run interactively.',
          );
        }
        if (!matrixEnv.MATRIX_OWNER_ID) {
          throw new Error(
            'Matrix quickstart requires an owner user id — pass --matrix-owner-id=@you:example.org or run interactively.',
          );
        }
        if (!MATRIX_USER_ID_RE.test(matrixEnv.MATRIX_OWNER_ID)) {
          throw new Error(`--matrix-owner-id "${matrixEnv.MATRIX_OWNER_ID}" doesn't look like ${MATRIX_OWNER_ID_HINT}.`);
        }
      } else {
        // Homeserver walkthrough: bot account -> access token -> owner mxid
        // -> room(s) to enable (below, via resolveMatrixRooms).
        output.write('\n🏠 Matrix quickstart — homeserver walkthrough\n');

        output.write('\n1) Homeserver URL: the base URL of the homeserver the BOT account lives on,\n');
        output.write('   e.g. https://matrix.example.org (self-hosted) or https://matrix.org.\n');
        matrixEnv.MATRIX_HOMESERVER_URL = await promptRequiredField(rl, getField('MATRIX_HOMESERVER_URL'), existing, {
          validate: (value) => /^https?:\/\//.test(value),
          invalidHint: 'a homeserver URL starts with https:// (or http:// on a trusted LAN)',
        });

        output.write('\n2) Create a dedicated bot account on that homeserver (register a normal user,\n');
        output.write("   e.g. @garbanzo-bot:example.org), then get its access token — simplest path:\n");
        output.write('   log the bot account into Element once, then Settings -> Help & About ->\n');
        output.write('   Advanced -> Access Token. (Or POST /_matrix/client/v3/login with the\n');
        output.write("   bot's password.) Treat the token like a password.\n");
        matrixEnv.MATRIX_ACCESS_TOKEN = await promptRequiredField(rl, getField('MATRIX_ACCESS_TOKEN'), existing);

        output.write('\n3) Owner user id: YOUR Matrix id (not the bot\'s), e.g. @you:example.org —\n');
        output.write('   owner escalations arrive as DMs to this account.\n');
        matrixEnv.MATRIX_OWNER_ID = await promptRequiredField(rl, getField('MATRIX_OWNER_ID'), existing, {
          validate: (value) => MATRIX_USER_ID_RE.test(value),
          invalidHint: MATRIX_OWNER_ID_HINT,
        });

        output.write('\nOptional Matrix settings:\n');
        matrixEnv.MATRIX_CHAT_SCOPE = await resolveText('MATRIX_CHAT_SCOPE');

        output.write('\n⚠️ Encrypted rooms are NOT supported (E2EE is deferred) — invite the bot\n');
        output.write('   only into unencrypted rooms, or it will sit blind in them.\n');
      }

      ({
        roomsMap: matrixRoomsMap,
        changed: matrixRoomsChanged,
        ownerId: existingMatrixRoomsOwnerId,
        existingConfig: existingMatrixRoomsConfig,
      } = await resolveMatrixRooms({
        nonInteractive,
        cli,
        rl,
        homeserverUrl: matrixEnv.MATRIX_HOMESERVER_URL || existing.MATRIX_HOMESERVER_URL || '',
        dryRun,
      }));
    }

    let deployTarget = 'docker';
    if (nonInteractive) {
      const requestedDeploy = (cli.options.deploy || 'docker').trim().toLowerCase();
      deployTarget = requestedDeploy === 'native' ? 'native' : 'docker';
    } else {
      const deployIndex = await promptChoice(
        rl,
        'Deployment target:',
        ['Docker Compose (recommended default)', 'Native Node.js process'],
        0,
      );
      deployTarget = deployIndex === 0 ? 'docker' : 'native';
    }

    output.write('\nCloud AI providers (at least one):\n');
    let useOpenRouter = true;
    let useAnthropic = true;
    let useOpenAI = true;
    let useGemini = false;
    let useBedrock = false;

    if (nonInteractive) {
      const providerCsv = cli.options.providers || cli.options.provider || '';
      if (providerCsv) {
        const providers = parseCsv(providerCsv).map((p) => p.toLowerCase());
        useOpenRouter = providers.includes('openrouter');
        useAnthropic = providers.includes('anthropic');
        useOpenAI = providers.includes('openai');
        useGemini = providers.includes('gemini');
        useBedrock = providers.includes('bedrock');
      } else {
        useOpenRouter = parseBoolean(cli.options['use-openrouter'], !!existing.OPENROUTER_API_KEY);
        useAnthropic = parseBoolean(cli.options['use-anthropic'], !!existing.ANTHROPIC_API_KEY);
        useOpenAI = parseBoolean(cli.options['use-openai'], !!existing.OPENAI_API_KEY);
        useGemini = parseBoolean(cli.options['use-gemini'], !!existing.GEMINI_API_KEY);
        useBedrock = parseBoolean(cli.options['use-bedrock'], !!existing.BEDROCK_MODEL_ID);
      }
    } else {
      useOpenRouter = yn(await rl.question(`Use OpenRouter Claude? [Y/n] (current: ${existing.OPENROUTER_API_KEY ? 'set' : 'empty'}): `), true);
      useAnthropic = yn(await rl.question(`Use Anthropic direct Claude? [Y/n] (current: ${existing.ANTHROPIC_API_KEY ? 'set' : 'empty'}): `), true);
      useOpenAI = yn(await rl.question(`Use OpenAI? [Y/n] (current: ${existing.OPENAI_API_KEY ? 'set' : 'empty'}): `), true);
      useGemini = yn(await rl.question(`Use Google Gemini? [y/N] (current: ${existing.GEMINI_API_KEY ? 'set' : 'empty'}): `), false);
      useBedrock = yn(await rl.question(`Use AWS Bedrock? [y/N] (current: ${existing.BEDROCK_MODEL_ID ? 'set' : 'empty'}): `), false);
    }

    if (!useOpenRouter && !useAnthropic && !useOpenAI && !useGemini && !useBedrock) {
      output.write('⚠️ No provider selected, enabling OpenAI fallback by default.\n');
      useOpenAI = true;
    }

    const selectedProviders = [];
    if (useOpenRouter) selectedProviders.push('openrouter');
    if (useAnthropic) selectedProviders.push('anthropic');
    if (useOpenAI) selectedProviders.push('openai');
    if (useGemini) selectedProviders.push('gemini');
    if (useBedrock) selectedProviders.push('bedrock');

    let providerOrder = [...selectedProviders];
    if (cli.options['provider-order']) {
      const requestedOrder = parseCsv(cli.options['provider-order']).map((p) => p.toLowerCase());
      const filtered = requestedOrder.filter((p) => selectedProviders.includes(p));
      const appended = selectedProviders.filter((p) => !filtered.includes(p));
      providerOrder = [...filtered, ...appended];
    } else if (selectedProviders.length > 1 && !nonInteractive) {
      output.write('\nConfigure cloud provider priority (first = primary):\n');
      const remaining = [...selectedProviders];
      const ordered = [];
      while (remaining.length > 0) {
        const idx = await promptChoice(
          rl,
          `Pick provider priority #${ordered.length + 1}:`,
          remaining.map((provider) => PROVIDER_LABELS[provider]),
          0,
        );
        const [picked] = remaining.splice(idx, 1);
        ordered.push(picked);
      }
      providerOrder = ordered;
    }

    const aiProviderOrder = providerOrder.join(',');

    let openaiAuthMode = 'apikey';
    if (useOpenAI) {
      if (nonInteractive) {
        const requested = (cli.options['openai-auth-mode'] ?? existing.OPENAI_AUTH_MODE ?? 'apikey').trim().toLowerCase();
        openaiAuthMode = OPENAI_AUTH_MODES.includes(requested) ? requested : 'apikey';
      } else {
        const authIndex = await promptChoice(
          rl,
          'OpenAI auth mode:',
          ['API key (recommended)', 'Sign in with ChatGPT (OAuth — experimental, ToS-grey)'],
          existing.OPENAI_AUTH_MODE === 'oauth' ? 1 : 0,
        );
        openaiAuthMode = authIndex === 1 ? 'oauth' : 'apikey';
        if (openaiAuthMode === 'oauth') {
          output.write('\n⚠️ "Sign in with ChatGPT" is experimental and against OpenAI ToS; the bot falls back to other providers if it breaks.\n');
          const loginNow = yn(await rl.question('Run `npm run openai:login` now to link your ChatGPT account? [y/N]: '), false);
          if (loginNow && dryRun) {
            output.write('🧪 Dry-run: would run npm run openai:login\n');
          } else if (loginNow) {
            try {
              execSync('npm run openai:login', { cwd: PROJECT_ROOT, stdio: 'inherit' });
            } catch {
              output.write('⚠️ openai:login did not complete; run `npm run openai:login` later.\n');
            }
          }
        }
      }
    }

    // Simple key/model/infra fields are resolved from the declarative FIELD_TABLE.
    const anthropicKey = useAnthropic ? await resolveText('ANTHROPIC_API_KEY') : '';
    const openRouterKey = useOpenRouter ? await resolveText('OPENROUTER_API_KEY') : '';
    // In OAuth mode OpenAI needs no API key, so skip that prompt.
    const openAIKey = useOpenAI && openaiAuthMode !== 'oauth' ? await resolveText('OPENAI_API_KEY') : '';
    const geminiKey = useGemini ? await resolveText('GEMINI_API_KEY') : '';

    const anthropicModel = await resolveText('ANTHROPIC_MODEL');
    const openRouterModel = await resolveText('OPENROUTER_MODEL');
    const openAIModel = await resolveText('OPENAI_MODEL');
    const geminiModel = await resolveText('GEMINI_MODEL');

    const geminiPricingInputPerM = await resolveText('GEMINI_PRICING_INPUT_PER_M');
    const geminiPricingOutputPerM = await resolveText('GEMINI_PRICING_OUTPUT_PER_M');

    const bedrockRegion = await resolveText('BEDROCK_REGION');
    const bedrockModelId = await resolveText('BEDROCK_MODEL_ID');
    const bedrockMaxTokens = await resolveText('BEDROCK_MAX_TOKENS');
    const bedrockPricingInputPerM = await resolveText('BEDROCK_PRICING_INPUT_PER_M');
    const bedrockPricingOutputPerM = await resolveText('BEDROCK_PRICING_OUTPUT_PER_M');

    // The field default (http://host.docker.internal:11434) only resolves
    // from inside a Docker container; native runs need the loopback address
    // instead (M2). resolveText() always falls back to the field's static
    // default when nothing else is set, which would otherwise make the
    // native default in finalEnv.OLLAMA_BASE_URL below dead code — so pick
    // the default here based on deployTarget, and still respect an explicit
    // CLI flag / existing .env value either way.
    const ollamaField = getField('OLLAMA_BASE_URL');
    const ollamaDefault = deployTarget === 'native' ? 'http://127.0.0.1:11434' : ollamaField.default;
    const ollamaBaseUrl = nonInteractive
      ? (cli.options[ollamaField.cli] ?? existing.OLLAMA_BASE_URL ?? ollamaDefault)
      : (await rl.question(`${ollamaField.env} (native runs: http://127.0.0.1:11434) [${existing.OLLAMA_BASE_URL ?? ollamaDefault}]: `)).trim() || ollamaDefault;
    if (messagingPlatform === 'whatsapp') {
      for (const field of WHATSAPP_FIELDS) {
        whatsappEnv[field.env] = await resolveText(field.env);
      }
      const requestedLoginMode = (whatsappEnv.WHATSAPP_LOGIN_MODE || 'web').trim().toLowerCase();
      whatsappEnv.WHATSAPP_LOGIN_MODE = WHATSAPP_LOGIN_MODES.includes(requestedLoginMode)
        ? requestedLoginMode
        : 'web';
    }
    const appVersion = nonInteractive
      ? (cli.options['app-version'] ?? existing.APP_VERSION ?? DEFAULT_APP_VERSION)
      : await rl.question(`APP_VERSION [${existing.APP_VERSION ?? DEFAULT_APP_VERSION}]: `);
    const healthPort = await resolveText('HEALTH_PORT');
    const healthBindHost = await resolveText('HEALTH_BIND_HOST');

    // Monitoring (Prometheus + Grafana) is a Docker Compose stack — off by
    // default for the native quickstart, and not even asked about since
    // there's no compose stack to enable.
    let monitoringEnabled = false;
    if (deployTarget === 'native') {
      output.write('\nℹ️ Monitoring (Prometheus + Grafana) is a Docker Compose stack — skipped for the native deploy target.\n');
    } else {
      monitoringEnabled = nonInteractive
        ? parseBoolean(cli.options.monitoring, parseBoolean(existing.METRICS_ENABLED, false))
        : yn(
            await rl.question('\nEnable monitoring (Prometheus + Grafana)? [y/N]: '),
            parseBoolean(existing.METRICS_ENABLED, false),
          );
    }

    const monitoringTokenInput = monitoringEnabled ? await resolveText('MONITORING_TOKEN') : '';
    let monitoringToken = (monitoringTokenInput || existing.MONITORING_TOKEN || '').trim();
    if (monitoringEnabled && !monitoringToken) {
      monitoringToken = generateMonitoringToken();
      output.write(
        '\n🔐 Generated a new MONITORING_TOKEN and stored it in .env — it authenticates /metrics, /admin, ' +
        'the Prometheus scrape, and (unless GRAFANA_ADMIN_PASSWORD is set) the Grafana admin login.\n',
      );
    }

    const githubSponsorsUrl = await resolveText('GITHUB_SPONSORS_URL');
    const patreonUrl = await resolveText('PATREON_URL');
    const kofiUrl = await resolveText('KOFI_URL');
    const supportCustomUrl = await resolveText('SUPPORT_CUSTOM_URL');
    const supportMessage = await resolveText('SUPPORT_MESSAGE');
    const githubIssuesToken = await resolveText('GITHUB_ISSUES_TOKEN');
    const githubIssuesRepo = await resolveText('GITHUB_ISSUES_REPO');

    const profileKeys = Object.keys(FEATURE_PROFILES);
    const profileLabels = profileKeys.map((key) => `${FEATURE_PROFILES[key].label} — ${FEATURE_PROFILES[key].description}`);
    let selectedProfileKey = 'full';
    if (nonInteractive) {
      selectedProfileKey = (cli.options.profile || 'full').trim().toLowerCase();
      if (!FEATURE_PROFILES[selectedProfileKey]) {
        throw new Error(`Unknown profile '${selectedProfileKey}'. Valid: ${profileKeys.join(', ')}`);
      }
    } else {
      const profileIndex = await promptChoice(rl, 'Feature profile:', profileLabels, 0);
      selectedProfileKey = profileKeys[profileIndex];
    }
    const selectedProfile = FEATURE_PROFILES[selectedProfileKey];

    let selectedFeatures = [...selectedProfile.features];
    if (nonInteractive) {
      if (cli.options.features) {
        selectedFeatures = sanitizeFeatureList(parseCsv(cli.options.features));
      }
    } else {
      const customizeFeatures = yn(
        await rl.question(`Customize enabled features? [y/N] (default profile has ${selectedFeatures.length}): `),
        false,
      );
      if (customizeFeatures) {
        output.write(`Valid features: ${ALL_FEATURES.join(', ')}\n`);
        const csv = await rl.question(`Enabled features (comma-separated) [${selectedFeatures.join(',')}]: `);
        selectedFeatures = sanitizeFeatureList(parseCsv(csv || selectedFeatures.join(',')));
      }
    }

    let customPersonaSourcePath = '';
    let customPersonaContent = '';
    // --persona-file: legacy path, non-interactive only, unchanged — replaces
    // docs/PERSONA.md at the HOME ROOT. Superseded interactively by the
    // persona gallery picker below, which targets the correct (platform-
    // keyed) slot; kept working standalone so existing automation and the
    // pinned H1 test never change behavior.
    const useCustomPersona = nonInteractive && !!cli.options['persona-file'];
    if (useCustomPersona) {
      const personaPathInput = cli.options['persona-file'] ?? '';
      customPersonaSourcePath = resolveUserPath(personaPathInput);
      if (!customPersonaSourcePath || !existsSync(customPersonaSourcePath)) {
        throw new Error(`Persona file not found: ${personaPathInput || '(empty path)'}`);
      }
      customPersonaContent = readFileSync(customPersonaSourcePath, 'utf-8');
      if (!customPersonaContent.trim()) {
        throw new Error('Persona file is empty');
      }
    }

    // Persona gallery picker (WS10). Writes to the PLATFORM-KEYED home slot
    // (GARBANZO_HOME/docs/personas/<platform>.md), not docs/PERSONA.md — a
    // shipped docs/personas/<platform>.md (e.g. discord.md) shadows a home
    // PERSONA.md at load time (src/ai/persona.ts's resolution order), so
    // writing PERSONA.md here would be silently ignored on every platform
    // that ships a default file. Independent of --persona-file above: both
    // can be set in the same run without interfering with each other.
    let personaSelectionContent = '';
    let personaSelectionSourcePath = '';
    let personaSelectionGalleryEntry = null;
    let personaSelectionRequested = false;

    if (nonInteractive) {
      const personaOption = (cli.options.persona ?? '').trim();
      if (personaOption && personaOption.toLowerCase() !== 'default') {
        const resolved = resolvePersonaSelection(personaOption);
        personaSelectionContent = resolved.content;
        personaSelectionSourcePath = resolved.sourcePath;
        personaSelectionGalleryEntry = resolved.galleryEntry;
        personaSelectionRequested = true;
      }
    } else {
      const pickerLabels = [
        'Default (Garbanzo Bean)',
        ...PERSONA_GALLERY.map((entry) => `${entry.label} — ${entry.useCase}`),
        'Custom persona file path',
      ];
      const pickerIndex = await promptChoice(rl, 'Persona:', pickerLabels, 0);
      if (pickerIndex >= 1 && pickerIndex <= PERSONA_GALLERY.length) {
        const entry = PERSONA_GALLERY[pickerIndex - 1];
        const filePath = resolve(GALLERY_DIR, entry.file);
        personaSelectionContent = readFileSync(filePath, 'utf-8');
        personaSelectionSourcePath = filePath;
        personaSelectionGalleryEntry = entry;
        personaSelectionRequested = true;
      } else if (pickerIndex === pickerLabels.length - 1) {
        const personaPathInput = await rl.question('Path to persona file (absolute or relative to project): ');
        const resolvedPath = resolveUserPath(personaPathInput);
        if (!resolvedPath || !existsSync(resolvedPath)) {
          throw new Error(`Persona file not found: ${personaPathInput || '(empty path)'}`);
        }
        const content = readFileSync(resolvedPath, 'utf-8');
        if (!content.trim()) {
          throw new Error('Persona file is empty');
        }
        personaSelectionContent = content;
        personaSelectionSourcePath = resolvedPath;
        personaSelectionRequested = true;
      }
    }

    // Riff and Callie are BAND_FEATURES_ENABLED demonstrations — offer (or
    // note) turning the flag on unless it's already set. The flag is only
    // wired into a compose/env slot for Discord today (band-member checks
    // read Discord roles), so the auto-enable action is Discord-only; other
    // platforms get the pairing note without an unprompted env write.
    if (personaSelectionGalleryEntry?.bandFeatures) {
      const bandFeaturesAlreadyEnabled = messagingPlatform === 'discord'
        ? bandDeployment
        : parseBoolean(existing.BAND_FEATURES_ENABLED, false);
      if (!bandFeaturesAlreadyEnabled) {
        if (messagingPlatform !== 'discord') {
          output.write(
            `\nℹ️ ${personaSelectionGalleryEntry.label} pairs with the band feature set (!song, !rehearsal, ` +
            '!setlist, !idea), which is wired for the Discord platform today — set BAND_FEATURES_ENABLED=true ' +
            'if/when you deploy this persona there.\n',
          );
        } else if (nonInteractive) {
          output.write(
            `\nℹ️ ${personaSelectionGalleryEntry.label} pairs with the band feature set (!song, !rehearsal, ` +
            '!setlist, !idea) — pass --band-features-enabled=true to turn it on.\n',
          );
        } else {
          const enableBand = yn(
            await rl.question(
              `\n${personaSelectionGalleryEntry.label} pairs with the band feature set (!song, !rehearsal, ` +
              '!setlist, !idea). Enable BAND_FEATURES_ENABLED now? [Y/n]: ',
            ),
            true,
          );
          if (enableBand) {
            discordEnv.BAND_FEATURES_ENABLED = 'true';
            output.write('✅ BAND_FEATURES_ENABLED set to true\n');
          }
        }
      }
    }

    let botName = existing.BOT_NAME || 'garbanzo';
    let groupId = '120000000000000000@g.us';
    let groupName = 'General';

    if (messagingPlatform === 'whatsapp') {
      if (nonInteractive) {
        botName = (cli.options['bot-name'] || existing.BOT_NAME || 'garbanzo').trim();
        groupId = (cli.options['group-id'] || '120000000000000000@g.us').trim();
        groupName = (cli.options['group-name'] || 'General').trim();
      } else {
        botName = (await rl.question(`Bot mention name [${existing.BOT_NAME ?? 'garbanzo'}]: `)).trim() || existing.BOT_NAME || 'garbanzo';
        const groupIdInput = (await rl.question('Primary WhatsApp group JID (eg 1203...@g.us) [120000000000000000@g.us]: ')).trim();
        groupId = groupIdInput || '120000000000000000@g.us';
        groupName = (await rl.question('Primary group name [General]: ')).trim() || 'General';
      }
    }

    const ownerName = nonInteractive
      ? (cli.options['owner-name'] || 'Owner').trim()
      : (await rl.question('Owner display name [Owner]: ')).trim() || 'Owner';

    const composeProfiles = resolveComposeProfiles(messagingPlatform, monitoringEnabled);

    const finalEnv = {
      MESSAGING_PLATFORM: messagingPlatform,
      COMPOSE_PROFILES: composeProfiles,
      METRICS_ENABLED: String(monitoringEnabled),
      MONITORING_TOKEN: monitoringToken,
      ANTHROPIC_API_KEY: (anthropicKey || existing.ANTHROPIC_API_KEY || '').trim(),
      OPENROUTER_API_KEY: (openRouterKey || existing.OPENROUTER_API_KEY || '').trim(),
      OPENAI_API_KEY: (openAIKey || existing.OPENAI_API_KEY || '').trim(),
      GEMINI_API_KEY: (geminiKey || existing.GEMINI_API_KEY || '').trim(),
      AI_PROVIDER_ORDER: aiProviderOrder,
      ANTHROPIC_MODEL: (anthropicModel || existing.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001').trim(),
      OPENROUTER_MODEL: (openRouterModel || existing.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5').trim(),
      OPENAI_MODEL: (openAIModel || existing.OPENAI_MODEL || 'gpt-5.4-mini').trim(),
      OPENAI_AUTH_MODE: (openaiAuthMode || existing.OPENAI_AUTH_MODE || 'apikey').trim(),
      GEMINI_MODEL: (geminiModel || existing.GEMINI_MODEL || 'gemini-1.5-flash').trim(),
      GEMINI_PRICING_INPUT_PER_M: String(geminiPricingInputPerM || existing.GEMINI_PRICING_INPUT_PER_M || '0').trim(),
      GEMINI_PRICING_OUTPUT_PER_M: String(geminiPricingOutputPerM || existing.GEMINI_PRICING_OUTPUT_PER_M || '0').trim(),
      BEDROCK_REGION: (bedrockRegion || existing.BEDROCK_REGION || 'us-east-1').trim(),
      BEDROCK_MODEL_ID: (bedrockModelId || existing.BEDROCK_MODEL_ID || '').trim(),
      BEDROCK_MAX_TOKENS: String(bedrockMaxTokens || existing.BEDROCK_MAX_TOKENS || '1024').trim(),
      BEDROCK_PRICING_INPUT_PER_M: String(bedrockPricingInputPerM || existing.BEDROCK_PRICING_INPUT_PER_M || '0').trim(),
      BEDROCK_PRICING_OUTPUT_PER_M: String(bedrockPricingOutputPerM || existing.BEDROCK_PRICING_OUTPUT_PER_M || '0').trim(),
      BOT_PHONE_NUMBER: (whatsappEnv.BOT_PHONE_NUMBER || existing.BOT_PHONE_NUMBER || '').trim(),
      GOOGLE_API_KEY: (existing.GOOGLE_API_KEY || '').trim(),
      MBTA_API_KEY: (existing.MBTA_API_KEY || '').trim(),
      NEWSAPI_KEY: (existing.NEWSAPI_KEY || '').trim(),
      BRAVE_SEARCH_API_KEY: (existing.BRAVE_SEARCH_API_KEY || '').trim(),
      GITHUB_SPONSORS_URL: (githubSponsorsUrl || existing.GITHUB_SPONSORS_URL || '').trim(),
      PATREON_URL: (patreonUrl || existing.PATREON_URL || '').trim(),
      KOFI_URL: (kofiUrl || existing.KOFI_URL || '').trim(),
      SUPPORT_CUSTOM_URL: (supportCustomUrl || existing.SUPPORT_CUSTOM_URL || '').trim(),
      SUPPORT_MESSAGE: (supportMessage || existing.SUPPORT_MESSAGE || '').trim(),
      GITHUB_ISSUES_TOKEN: (githubIssuesToken || existing.GITHUB_ISSUES_TOKEN || '').trim(),
      GITHUB_ISSUES_REPO: (githubIssuesRepo || existing.GITHUB_ISSUES_REPO || 'owner/repo').trim(),
      OLLAMA_BASE_URL: (ollamaBaseUrl || existing.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim(),
      LOG_LEVEL: (existing.LOG_LEVEL || 'info').trim(),
      APP_VERSION: (appVersion || existing.APP_VERSION || DEFAULT_APP_VERSION).trim(),
      HEALTH_PORT: (healthPort || existing.HEALTH_PORT || '3001').trim(),
      HEALTH_BIND_HOST: (healthBindHost || existing.HEALTH_BIND_HOST || '127.0.0.1').trim(),
      SLACK_DEMO: (messagingPlatform === 'slack' ? String(slackDemo) : (existing.SLACK_DEMO || 'false')).trim(),
      SLACK_DEMO_PORT: (existing.SLACK_DEMO_PORT || '3002').trim(),
      SLACK_DEMO_BIND_HOST: (existing.SLACK_DEMO_BIND_HOST || '127.0.0.1').trim(),
      DISCORD_BOT_TOKEN: (discordEnv.DISCORD_BOT_TOKEN || existing.DISCORD_BOT_TOKEN || '').trim(),
      DISCORD_PUBLIC_KEY: (discordEnv.DISCORD_PUBLIC_KEY || existing.DISCORD_PUBLIC_KEY || '').trim(),
      DISCORD_OWNER_ID: (discordEnv.DISCORD_OWNER_ID || existing.DISCORD_OWNER_ID || '').trim(),
      DISCORD_GATEWAY_ENABLED: (discordEnv.DISCORD_GATEWAY_ENABLED || existing.DISCORD_GATEWAY_ENABLED || 'true').trim(),
      DISCORD_DIGEST_CHANNEL_ID: (discordEnv.DISCORD_DIGEST_CHANNEL_ID || existing.DISCORD_DIGEST_CHANNEL_ID || '').trim(),
      DISCORD_RECAP_CHANNEL_ID: (discordEnv.DISCORD_RECAP_CHANNEL_ID || existing.DISCORD_RECAP_CHANNEL_ID || '').trim(),
      DISCORD_CHANNELS_CONFIG_PATH: (existing.DISCORD_CHANNELS_CONFIG_PATH || 'config/discord-channels.json').trim(),
      BAND_FEATURES_ENABLED: (discordEnv.BAND_FEATURES_ENABLED || existing.BAND_FEATURES_ENABLED || 'false').trim(),
      QDRANT_COLLECTION: String(qdrantCollection || existing.QDRANT_COLLECTION || 'garbanzo_memory').trim(),
      OWNER_JID: (whatsappEnv.OWNER_JID || existing.OWNER_JID || 'your_number@s.whatsapp.net').trim(),
      WHATSAPP_LOGIN_MODE: (whatsappEnv.WHATSAPP_LOGIN_MODE || existing.WHATSAPP_LOGIN_MODE || 'web').trim(),
      TELEGRAM_BOT_TOKEN: (telegramEnv.TELEGRAM_BOT_TOKEN || existing.TELEGRAM_BOT_TOKEN || '').trim(),
      TELEGRAM_OWNER_ID: (telegramEnv.TELEGRAM_OWNER_ID || existing.TELEGRAM_OWNER_ID || '').trim(),
      TELEGRAM_CHAT_SCOPE: (telegramEnv.TELEGRAM_CHAT_SCOPE || existing.TELEGRAM_CHAT_SCOPE || 'configured').trim(),
      TELEGRAM_CHATS_CONFIG_PATH: (existing.TELEGRAM_CHATS_CONFIG_PATH || 'config/telegram-chats.json').trim(),
      MATRIX_HOMESERVER_URL: (matrixEnv.MATRIX_HOMESERVER_URL || existing.MATRIX_HOMESERVER_URL || '').trim(),
      MATRIX_ACCESS_TOKEN: (matrixEnv.MATRIX_ACCESS_TOKEN || existing.MATRIX_ACCESS_TOKEN || '').trim(),
      MATRIX_OWNER_ID: (matrixEnv.MATRIX_OWNER_ID || existing.MATRIX_OWNER_ID || '').trim(),
      MATRIX_CHAT_SCOPE: (matrixEnv.MATRIX_CHAT_SCOPE || existing.MATRIX_CHAT_SCOPE || 'configured').trim(),
      MATRIX_ROOMS_CONFIG_PATH: (existing.MATRIX_ROOMS_CONFIG_PATH || 'config/matrix-rooms.json').trim(),
    };

    // Layered emission (modular-config v2): `.env` carries only the shared
    // fields (provider keys/models, MONITORING_TOKEN, health, integrations,
    // COMPOSE_PROFILES) so it never needs edits when switching platforms;
    // `.env.discord` / `.env.whatsapp` carry that platform's instance keys
    // only. Every emitted key lives in exactly one file — see
    // docs/superpowers/specs/2026-07-04-modular-config-design.md.
    let sharedEnvContent = buildSharedEnvLines(finalEnv).join('\n');

    // Native quickstart defaults (D3): no COMPOSE_PROFILES (that variable only
    // means anything to `docker compose`) and VECTOR_STORE=none (keyword-only
    // memory, no Qdrant container to run). Docker path is unchanged.
    const vectorStoreNote = 'Native default: VECTOR_STORE=none (keyword-only memory, no Qdrant required). '
      + 'Upgrade later by setting VECTOR_STORE=qdrant + QDRANT_URL, or switch to the Docker Compose path.';
    if (deployTarget === 'native') {
      sharedEnvContent = sharedEnvContent
        .split('\n')
        .filter((line) => !line.startsWith('COMPOSE_PROFILES='))
        .join('\n');
      const vectorStoreValue = (cli.options['vector-store'] ?? existing.VECTOR_STORE ?? 'none').trim();
      sharedEnvContent += [
        '',
        '# Native quickstart default — see docs/QUICKSTART.md to upgrade to Qdrant.',
        `VECTOR_STORE=${vectorStoreValue}`,
        '',
      ].join('\n');
      output.write(`\nℹ️ ${vectorStoreNote}\n`);
    }

    const envTargets = [{ path: ENV_PATH, content: mergeEnvTargetContent(ENV_PATH, sharedEnvContent), label: '.env' }];
    if (messagingPlatform === 'discord') {
      let discordEnvContent = buildPlatformEnvLines('discord', finalEnv).join('\n');
      if (discordClientId) {
        discordEnvContent += [
          '',
          '# Application (client) ID — used to regenerate the bot invite URL later.',
          `DISCORD_CLIENT_ID=${discordClientId}`,
          '',
        ].join('\n');
      }
      envTargets.push({
        path: ENV_DISCORD_PATH,
        content: mergeEnvTargetContent(ENV_DISCORD_PATH, discordEnvContent),
        label: '.env.discord',
      });
    } else if (messagingPlatform === 'whatsapp') {
      envTargets.push({
        path: ENV_WHATSAPP_PATH,
        content: mergeEnvTargetContent(ENV_WHATSAPP_PATH, buildPlatformEnvLines('whatsapp', finalEnv).join('\n')),
        label: '.env.whatsapp',
      });
    } else if (messagingPlatform === 'telegram') {
      envTargets.push({
        path: ENV_TELEGRAM_PATH,
        content: mergeEnvTargetContent(ENV_TELEGRAM_PATH, buildPlatformEnvLines('telegram', finalEnv).join('\n')),
        label: '.env.telegram',
      });
    } else if (messagingPlatform === 'matrix') {
      envTargets.push({
        path: ENV_MATRIX_PATH,
        content: mergeEnvTargetContent(ENV_MATRIX_PATH, buildPlatformEnvLines('matrix', finalEnv).join('\n')),
        label: '.env.matrix',
      });
    }

    const writtenEnvFiles = [];
    if (dryRun) {
      for (const target of envTargets) {
        output.write(`\n🧪 Dry-run: would write ${target.label} with these contents:\n`);
        output.write(`--- ${target.label} (preview) ---\n`);
        output.write(`${redactEnvContent(target.content)}\n`);
        output.write(`--- end ${target.label} preview ---\n`);
      }
    } else {
      for (const target of envTargets) {
        if (existsSync(target.path)) {
          copyFileSync(target.path, `${target.path}.bak`);
          output.write(`\n🗂️ Existing ${target.label} backed up to ${target.label}.bak\n`);
        }
        writeFileSync(target.path, target.content, 'utf-8');
        output.write(`✅ Wrote ${target.label}\n`);
        writtenEnvFiles.push(target.label);
      }
    }

    if (customPersonaContent) {
      if (dryRun) {
        output.write(`🧪 Dry-run: would replace docs/PERSONA.md from ${customPersonaSourcePath}\n`);
      } else {
        // Unlike the .env/config writes (which mkdir OUTPUT_ROOT/config
        // themselves), OUTPUT_ROOT/docs is never created elsewhere — a fresh
        // GARBANZO_HOME has no docs/ dir, so writeFileSync would ENOENT
        // without this (H1).
        mkdirSync(dirname(PERSONA_PATH), { recursive: true });
        if (existsSync(PERSONA_PATH)) {
          copyFileSync(PERSONA_PATH, `${PERSONA_PATH}.bak`);
          output.write('🗂️ Existing docs/PERSONA.md backed up to docs/PERSONA.md.bak\n');
        }
        writeFileSync(
          PERSONA_PATH,
          customPersonaContent.endsWith('\n') ? customPersonaContent : `${customPersonaContent}\n`,
          'utf-8',
        );
        output.write(`✅ Wrote docs/PERSONA.md from ${customPersonaSourcePath}\n`);
      }
    }

    if (personaSelectionRequested) {
      const galleryTargetPath = resolve(OUTPUT_ROOT, 'docs', 'personas', `${messagingPlatform}.md`);
      const galleryTargetLabel = `docs/personas/${messagingPlatform}.md`;
      if (dryRun) {
        output.write(`🧪 Dry-run: would write ${galleryTargetLabel} from ${personaSelectionSourcePath}\n`);
      } else {
        // Same H1 rationale as the docs/PERSONA.md write above — a fresh
        // GARBANZO_HOME has no docs/personas/ dir yet.
        mkdirSync(dirname(galleryTargetPath), { recursive: true });
        if (existsSync(galleryTargetPath)) {
          copyFileSync(galleryTargetPath, `${galleryTargetPath}.bak`);
          output.write(`🗂️ Existing ${galleryTargetLabel} backed up to ${galleryTargetLabel}.bak\n`);
        }
        writeFileSync(
          galleryTargetPath,
          personaSelectionContent.endsWith('\n') ? personaSelectionContent : `${personaSelectionContent}\n`,
          'utf-8',
        );
        output.write(`✅ Wrote ${galleryTargetLabel} from ${personaSelectionSourcePath}\n`);
      }
    }

    const shouldWriteGroups = messagingPlatform === 'whatsapp'
      ? (nonInteractive
          ? parseBoolean(cli.options['write-groups'], true)
          : yn(await rl.question('Write config/groups.json from setup choices? [Y/n]: '), true))
      : false;

    if (shouldWriteGroups) {
      let existingGroupsConfig = null;
      if (existsSync(GROUPS_PATH)) {
        try {
          existingGroupsConfig = JSON.parse(readFileSync(GROUPS_PATH, 'utf-8'));
        } catch (err) {
          throw new Error(`config/groups.json exists but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const existingGroupsRecord = asRecord(existingGroupsConfig);
      const existingAdminsRecord = asRecord(existingGroupsRecord.admins);
      const groupsConfig = {
        ...existingGroupsRecord,
        groups: {
          ...asRecord(existingGroupsRecord.groups),
          [groupId]: {
            name: groupName,
            enabled: true,
            requireMention: true,
            persona: selectedProfile.persona,
            enabledFeatures: selectedFeatures,
          },
        },
        mentionPatterns: [`@${botName}`, `@${botName.charAt(0).toUpperCase()}${botName.slice(1)}`, '@bot'],
        admins: {
          ...existingAdminsRecord,
          owner: {
            name: ownerName,
            jid: finalEnv.OWNER_JID,
          },
          moderators: Array.isArray(existingAdminsRecord.moderators) ? existingAdminsRecord.moderators : [],
        },
      };

      if (dryRun) {
        output.write('🧪 Dry-run: would write config/groups.json with these contents:\n');
        output.write('--- config/groups.json (preview) ---\n');
        output.write(`${JSON.stringify(groupsConfig, null, 2)}\n`);
        output.write('--- end groups.json preview ---\n');
      } else {
        mkdirSync(resolve(OUTPUT_ROOT, 'config'), { recursive: true });
        writeFileSync(GROUPS_PATH, `${JSON.stringify(groupsConfig, null, 2)}\n`, 'utf-8');
        output.write('✅ Wrote config/groups.json\n');
      }
    } else if (messagingPlatform !== 'whatsapp') {
      output.write('ℹ️ Skipped groups.json generation (only needed for WhatsApp runtime).\n');
    }

    // The quickstart cannot complete with zero enabled channels (D3) —
    // resolveDiscordChannels() above already enforces this (failing outright
    // non-interactively, or re-prompting interactively) and merges any
    // --discord-channel-id(s) from this run into an existing file (M1)
    // instead of silently discarding them, so `discordChannelsChanged` here
    // just decides whether the file needs to be (re)written at all.
    if (messagingPlatform === 'discord') {
      if (!discordChannelsChanged) {
        output.write('ℹ️ Using existing config/discord-channels.json; leaving it unchanged.\n');
      } else {
        const resolvedOwnerId = existingChannelsOwnerId || finalEnv.DISCORD_OWNER_ID;
        const channelsConfig = {
          ...asRecord(existingDiscordChannelsConfig),
          ...(resolvedOwnerId ? { ownerId: resolvedOwnerId } : {}),
          channels: discordChannelsMap,
        };

        if (dryRun) {
          output.write('🧪 Dry-run: would write config/discord-channels.json with these contents:\n');
          output.write('--- config/discord-channels.json (preview) ---\n');
          output.write(`${JSON.stringify(channelsConfig, null, 2)}\n`);
          output.write('--- end discord-channels.json preview ---\n');
        } else {
          mkdirSync(resolve(OUTPUT_ROOT, 'config'), { recursive: true });
          if (existsSync(DISCORD_CHANNELS_PATH)) {
            copyFileSync(DISCORD_CHANNELS_PATH, `${DISCORD_CHANNELS_PATH}.bak`);
            output.write('🗂️ Existing config/discord-channels.json backed up to config/discord-channels.json.bak\n');
          }
          writeFileSync(DISCORD_CHANNELS_PATH, `${JSON.stringify(channelsConfig, null, 2)}\n`, 'utf-8');
          const count = Object.values(discordChannelsMap).filter((entry) => entry && entry.enabled).length;
          output.write(`✅ Wrote config/discord-channels.json with ${count} enabled channel${count === 1 ? '' : 's'}\n`);
        }
        output.write('ℹ️ Add more channels later by editing config/discord-channels.json (schema: config/discord-channels.example.json).\n');
      }
    }

    // Same contract as the Discord channels block above, for
    // config/telegram-chats.json (resolveTelegramChats() already enforces at
    // least one enabled chat).
    if (messagingPlatform === 'telegram') {
      if (!telegramChatsChanged) {
        output.write('ℹ️ Using existing config/telegram-chats.json; leaving it unchanged.\n');
      } else {
        const resolvedTelegramOwnerId = existingTelegramChatsOwnerId || finalEnv.TELEGRAM_OWNER_ID;
        const telegramChatsConfig = {
          ...asRecord(existingTelegramChatsConfig),
          ...(resolvedTelegramOwnerId ? { ownerId: resolvedTelegramOwnerId } : {}),
          chats: telegramChatsMap,
        };

        if (dryRun) {
          output.write('🧪 Dry-run: would write config/telegram-chats.json with these contents:\n');
          output.write('--- config/telegram-chats.json (preview) ---\n');
          output.write(`${JSON.stringify(telegramChatsConfig, null, 2)}\n`);
          output.write('--- end telegram-chats.json preview ---\n');
        } else {
          mkdirSync(resolve(OUTPUT_ROOT, 'config'), { recursive: true });
          if (existsSync(TELEGRAM_CHATS_PATH)) {
            copyFileSync(TELEGRAM_CHATS_PATH, `${TELEGRAM_CHATS_PATH}.bak`);
            output.write('🗂️ Existing config/telegram-chats.json backed up to config/telegram-chats.json.bak\n');
          }
          writeFileSync(TELEGRAM_CHATS_PATH, `${JSON.stringify(telegramChatsConfig, null, 2)}\n`, 'utf-8');
          const count = Object.values(telegramChatsMap).filter((entry) => entry && entry.enabled).length;
          output.write(`✅ Wrote config/telegram-chats.json with ${count} enabled chat${count === 1 ? '' : 's'}\n`);
        }
        output.write('ℹ️ Add more chats later by editing config/telegram-chats.json (schema: config/telegram-chats.example.json).\n');
      }
    }

    // Same contract for config/matrix-rooms.json (resolveMatrixRooms()
    // already enforced at least one enabled room, resolving aliases to ids).
    if (messagingPlatform === 'matrix') {
      if (!matrixRoomsChanged) {
        output.write('ℹ️ Using existing config/matrix-rooms.json; leaving it unchanged.\n');
      } else {
        const resolvedMatrixOwnerId = existingMatrixRoomsOwnerId || finalEnv.MATRIX_OWNER_ID;
        const matrixRoomsConfig = {
          ...asRecord(existingMatrixRoomsConfig),
          ...(resolvedMatrixOwnerId ? { ownerId: resolvedMatrixOwnerId } : {}),
          rooms: matrixRoomsMap,
        };

        if (dryRun) {
          output.write('🧪 Dry-run: would write config/matrix-rooms.json with these contents:\n');
          output.write('--- config/matrix-rooms.json (preview) ---\n');
          output.write(`${JSON.stringify(matrixRoomsConfig, null, 2)}\n`);
          output.write('--- end matrix-rooms.json preview ---\n');
        } else {
          mkdirSync(resolve(OUTPUT_ROOT, 'config'), { recursive: true });
          if (existsSync(MATRIX_ROOMS_PATH)) {
            copyFileSync(MATRIX_ROOMS_PATH, `${MATRIX_ROOMS_PATH}.bak`);
            output.write('🗂️ Existing config/matrix-rooms.json backed up to config/matrix-rooms.json.bak\n');
          }
          writeFileSync(MATRIX_ROOMS_PATH, `${JSON.stringify(matrixRoomsConfig, null, 2)}\n`, 'utf-8');
          const count = Object.values(matrixRoomsMap).filter((entry) => entry && entry.enabled).length;
          output.write(`✅ Wrote config/matrix-rooms.json with ${count} enabled room${count === 1 ? '' : 's'}\n`);
        }
        output.write('ℹ️ Add more rooms later by editing config/matrix-rooms.json (schema: config/matrix-rooms.example.json).\n');
      }
    }

    // Pre-commit hook install is a repo-contributor concern — only relevant
    // when the wizard is writing into the checkout itself (no GARBANZO_HOME
    // redirect), and only when that checkout has a .git dir.
    const isRepoModeOutput = OUTPUT_ROOT === PROJECT_ROOT;
    if (!dryRun && isRepoModeOutput && existsSync(resolve(PROJECT_ROOT, '.git'))) {
      copyFileSync(resolve(PROJECT_ROOT, 'scripts', 'pre-commit'), resolve(PROJECT_ROOT, '.git', 'hooks', 'pre-commit'));
      output.write('✅ Installed pre-commit hook\n');
    } else if (dryRun && isRepoModeOutput && existsSync(resolve(PROJECT_ROOT, '.git'))) {
      output.write('🧪 Dry-run: would install pre-commit hook\n');
    }

    output.write('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    output.write('✅ Setup complete\n');
    output.write(`- Messaging platform: ${messagingPlatform}\n`);
    if (deployTarget === 'docker') {
      output.write(`- Compose profiles: ${composeProfiles}\n`);
    }
    output.write(`- Env files written: ${dryRun ? '(preview only — see above)' : writtenEnvFiles.join(', ')}\n`);
    output.write(`- Monitoring (Prometheus + Grafana): ${monitoringEnabled ? 'enabled' : 'disabled'}\n`);
    output.write(`- Cloud provider order: ${aiProviderOrder}\n`);
    if (useOpenAI) output.write(`- OpenAI auth mode: ${finalEnv.OPENAI_AUTH_MODE}\n`);
    if (messagingPlatform === 'whatsapp') output.write(`- WhatsApp login mode: ${finalEnv.WHATSAPP_LOGIN_MODE}\n`);
    output.write(`- Feature profile: ${selectedProfile.label}\n`);
    output.write(`- Enabled features: ${selectedFeatures.join(', ')}\n`);
    output.write(`- Persona source: ${customPersonaContent ? customPersonaSourcePath : 'existing docs/PERSONA.md'}\n`);
    output.write(
      `- Persona gallery selection: ${personaSelectionRequested
        ? `${personaSelectionGalleryEntry ? personaSelectionGalleryEntry.label : personaSelectionSourcePath} -> docs/personas/${messagingPlatform}.md`
        : 'default (Garbanzo Bean, no file written)'}\n`,
    );
    output.write(`- Deploy target: ${deployTarget === 'docker' ? 'docker compose' : 'native node'}\n`);
    output.write(`- Write mode: ${dryRun ? 'preview only' : 'write files'}\n`);
    if (deployTarget === 'native') {
      output.write(`- Vector memory: ${vectorStoreNote}\n`);
    }
    output.write(`- Files written under: ${OUTPUT_ROOT}\n`);

    if (messagingPlatform === 'slack') {
      output.write(`- Slack demo mode: ${finalEnv.SLACK_DEMO}\n`);
      if (finalEnv.SLACK_DEMO === 'true') {
        output.write('\nℹ️ Slack demo mode is local-only and does not connect to Slack APIs.\n');
      } else {
        output.write('\nℹ️ Slack official runtime requires SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET in .env.\n');
      }
    }

    if (messagingPlatform === 'discord') {
      output.write(`- Discord gateway enabled: ${finalEnv.DISCORD_GATEWAY_ENABLED}\n`);
      output.write(`- Band deployment (Remy): ${finalEnv.BAND_FEATURES_ENABLED}\n`);
      output.write(`- Qdrant collection: ${finalEnv.QDRANT_COLLECTION}\n`);
      const enabledChannelIds = Object.keys(discordChannelsMap).filter((id) => discordChannelsMap[id]?.enabled);
      output.write(`- Enabled channels: ${discordChannelsChanged ? enabledChannelIds.join(', ') : '(existing config/discord-channels.json unchanged)'}\n`);
      if (discordClientId) {
        output.write(`- Invite URL: ${buildDiscordInviteUrl(discordClientId)}\n`);
      }
    }

    if (messagingPlatform === 'telegram') {
      output.write(`- Telegram chat scope: ${finalEnv.TELEGRAM_CHAT_SCOPE}\n`);
      const enabledChatIds = Object.keys(telegramChatsMap).filter((id) => telegramChatsMap[id]?.enabled);
      output.write(`- Enabled chats: ${telegramChatsChanged ? enabledChatIds.join(', ') : '(existing config/telegram-chats.json unchanged)'}\n`);
      output.write('- Privacy mode: disable it via @BotFather -> /setprivacy -> Disable (manual step, see walkthrough above)\n');
    }

    if (messagingPlatform === 'matrix') {
      output.write(`- Matrix chat scope: ${finalEnv.MATRIX_CHAT_SCOPE}\n`);
      const enabledRoomIds = Object.keys(matrixRoomsMap).filter((id) => matrixRoomsMap[id]?.enabled);
      output.write(`- Enabled rooms: ${matrixRoomsChanged ? enabledRoomIds.join(', ') : '(existing config/matrix-rooms.json unchanged)'}\n`);
      output.write('- Encrypted rooms are unsupported (E2EE deferred) — invite the bot only into unencrypted rooms\n');
      output.write('- Sync token persists in data/matrix-sync.json (inside the data volume/GARBANZO_HOME)\n');
    }

    if (deployTarget === 'docker') {
      output.write('\nNext commands:\n');
      output.write('  docker compose up -d\n');
      output.write(`  docker compose logs -f ${messagingPlatform}\n`);
    } else {
      output.write('\nNext commands:\n');
      // GARBANZO_CLI=1 is set by the packaged `garbanzo` CLI when it spawns
      // this wizard (wired in T6 packaging); repo-mode runs (npm run setup)
      // don't set it, so they get the build+start pair instead.
      if (IS_PACKAGED_RUN) {
        output.write('  garbanzo start\n');
      } else {
        output.write('  npm run build && npm start\n');
        output.write('  (development/hot-reload: npm run dev)\n');
      }
    }
    output.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } finally {
    intentionalClose = true;
    rl.close();
  }
}

main().catch((err) => {
  output.write(`\n❌ Setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
