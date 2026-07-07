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
  getField,
  promptHint,
  resolveEnvField,
  resolveMessagingPlatform,
  mergeExistingEnvForPlatform,
  generateMonitoringToken,
  resolveComposeProfiles,
  buildPlatformEnvLines,
  buildSharedEnvLines,
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
const GROUPS_PATH = resolve(OUTPUT_ROOT, 'config', 'groups.json');
const DISCORD_CHANNELS_PATH = resolve(OUTPUT_ROOT, 'config', 'discord-channels.json');
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

  return { channelsMap, changed, ownerId: existingConfig?.ownerId };
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
    output.write('  npm run setup -- --non-interactive --app-version=0.2.0 --github-issues-repo=owner/repo --github-issues-token=$GITHUB_ISSUES_TOKEN\n');
    output.write('  npm run setup -- --non-interactive --dry-run --providers=openai --profile=lightweight\n');
    output.write('  npm run setup -- --non-interactive --platform=discord --deploy=native --discord-bot-token=$DISCORD_BOT_TOKEN --discord-client-id=123... --discord-owner-id=456... --discord-channel-id=789... --providers=openai --openai-key=$OPENAI_API_KEY\n');
    output.write('  npm run setup -- --non-interactive --platform=discord --deploy=native --discord-bot-token=$DISCORD_BOT_TOKEN --discord-owner-id=456... --discord-channel-ids=789...,790... --discord-channel-name=general --install-deps=false --vector-store=none --providers=openai --openai-key=$OPENAI_API_KEY\n');
    output.write('\nOther non-interactive flags:\n');
    output.write('  --discord-channel-ids   comma-separated Discord channel IDs to enable (alias for --discord-channel-id)\n');
    output.write('  --discord-channel-name  label applied to every channel in --discord-channel-id(s) (default: general)\n');
    output.write('  --install-deps          true/false — run `npm install` before writing config (default: true unless GARBANZO_CLI=1)\n');
    output.write('  --vector-store          native deploy target only — VECTOR_STORE value written to .env (default: none)\n');
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
  let intentionalClose = false;
  rl.on('close', () => {
    if (!intentionalClose) {
      process.stderr.write('Setup aborted before completion\n');
      process.exit(1);
    }
  });

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
    // its account-risk caveat. Slack/Teams are scaffold/dead-SDK paths — not
    // offered on the interactive menu, but still reachable non-interactively
    // via --platform=slack|teams (resolveMessagingPlatform below), so the
    // existing Slack dry-run coverage keeps working unchanged.
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
        ],
        existing.MESSAGING_PLATFORM === 'whatsapp' ? 1 : 0,
      );
      messagingPlatform = platformIndex === 1 ? 'whatsapp' : 'discord';
    }

    const platformEnvPath = messagingPlatform === 'discord'
      ? ENV_DISCORD_PATH
      : messagingPlatform === 'whatsapp'
        ? ENV_WHATSAPP_PATH
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
    let bandDeployment = false;
    let qdrantCollection = existing.QDRANT_COLLECTION || 'garbanzo_memory';
    let discordClientId = '';
    // Populated below by resolveDiscordChannels() once token/owner ID are
    // resolved; { channelsMap, changed, ownerId }.
    let discordChannelsMap = {};
    let discordChannelsChanged = false;
    let existingChannelsOwnerId;
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
    const useCustomPersona = nonInteractive
      ? !!cli.options['persona-file']
      : yn(await rl.question('Provide a custom PERSONA.md file now? [y/N]: '), false);
    if (useCustomPersona) {
      const personaPathInput = nonInteractive
        ? (cli.options['persona-file'] ?? '')
        : await rl.question('Path to PERSONA.md (absolute or relative to project): ');
      customPersonaSourcePath = resolveUserPath(personaPathInput);
      if (!customPersonaSourcePath || !existsSync(customPersonaSourcePath)) {
        throw new Error(`Persona file not found: ${personaPathInput || '(empty path)'}`);
      }
      customPersonaContent = readFileSync(customPersonaSourcePath, 'utf-8');
      if (!customPersonaContent.trim()) {
        throw new Error('Persona file is empty');
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

    const envTargets = [{ path: ENV_PATH, content: sharedEnvContent, label: '.env' }];
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
        content: discordEnvContent,
        label: '.env.discord',
      });
    } else if (messagingPlatform === 'whatsapp') {
      envTargets.push({
        path: ENV_WHATSAPP_PATH,
        content: buildPlatformEnvLines('whatsapp', finalEnv).join('\n'),
        label: '.env.whatsapp',
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

    const shouldWriteGroups = messagingPlatform === 'whatsapp'
      ? (nonInteractive
          ? parseBoolean(cli.options['write-groups'], true)
          : yn(await rl.question('Write config/groups.json from setup choices? [Y/n]: '), true))
      : false;

    if (shouldWriteGroups) {
      const groupsConfig = {
        groups: {
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
          owner: {
            name: ownerName,
            jid: finalEnv.OWNER_JID,
          },
          moderators: [],
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
    output.write(`- Deploy target: ${deployTarget === 'docker' ? 'docker compose' : 'native node'}\n`);
    output.write(`- Write mode: ${dryRun ? 'preview only' : 'write files'}\n`);
    if (deployTarget === 'native') {
      output.write(`- Vector memory: ${vectorStoreNote}\n`);
    }
    output.write(`- Files written under: ${OUTPUT_ROOT}\n`);

    if (messagingPlatform === 'teams') {
      output.write('\n⚠️ Teams runtime support is planned but not implemented yet.\n');
      output.write('   Current runtime support is WhatsApp, Slack, and Discord.\n');
    }

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
