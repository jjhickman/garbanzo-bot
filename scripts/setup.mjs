#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const PROJECT_ROOT = resolve(new URL('..', import.meta.url).pathname);
const ENV_PATH = resolve(PROJECT_ROOT, '.env');
const ENV_DISCORD_PATH = resolve(PROJECT_ROOT, '.env.discord');
const ENV_WHATSAPP_PATH = resolve(PROJECT_ROOT, '.env.whatsapp');
const GROUPS_PATH = resolve(PROJECT_ROOT, 'config', 'groups.json');
const DISCORD_CHANNELS_PATH = resolve(PROJECT_ROOT, 'config', 'discord-channels.json');
const DISCORD_CHANNELS_EXAMPLE_PATH = resolve(PROJECT_ROOT, 'config', 'discord-channels.example.json');
const PERSONA_PATH = resolve(PROJECT_ROOT, 'docs', 'PERSONA.md');
const PACKAGE_JSON_PATH = resolve(PROJECT_ROOT, 'package.json');

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

  const rl = createInterface({ input, output });
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

    let messagingPlatform = 'discord';
    if (nonInteractive) {
      messagingPlatform = resolveMessagingPlatform(cli, existing);
    } else {
      const platformIndex = await promptChoice(
        rl,
        'Messaging platform:',
        [
          'Discord (official runtime + demo mode)',
          'WhatsApp (unofficial API)',
          'Slack (official runtime + demo mode)',
          'Teams (planned; runtime support pending)',
        ],
        existing.MESSAGING_PLATFORM === 'whatsapp'
          ? 1
          : existing.MESSAGING_PLATFORM === 'slack'
            ? 2
            : existing.MESSAGING_PLATFORM === 'teams'
              ? 3
              : 0,
      );
      messagingPlatform = platformIndex === 1
        ? 'whatsapp'
        : platformIndex === 2
          ? 'slack'
          : platformIndex === 3
            ? 'teams'
            : 'discord';
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
    let shouldScaffoldDiscordChannels = false;
    if (messagingPlatform === 'discord') {
      for (const field of DISCORD_FIELDS.filter((candidate) => candidate.env !== 'BAND_FEATURES_ENABLED')) {
        discordEnv[field.env] = await resolveText(field.env);
      }

      if (nonInteractive) {
        const bandValue = resolveEnvField(getField('BAND_FEATURES_ENABLED'), cli, existing);
        bandDeployment = parseBoolean(bandValue, false);
      } else {
        const existingBandDeployment = parseBoolean(existing.BAND_FEATURES_ENABLED, false);
        bandDeployment = yn(
          await rl.question(`Is this a band deployment (Remy)? [${existingBandDeployment ? 'Y/n' : 'y/N'}]: `),
          existingBandDeployment,
        );
      }
      discordEnv.BAND_FEATURES_ENABLED = String(bandDeployment);

      const qdrantDefault = defaultQdrantCollectionForBand(bandDeployment, existing.QDRANT_COLLECTION);
      qdrantCollection = nonInteractive
        ? (cli.options['qdrant-collection'] ?? qdrantDefault)
        : ((await rl.question(`QDRANT_COLLECTION [${qdrantDefault}]: `)).trim() || qdrantDefault);

      if (bandDeployment && !existsSync(DISCORD_CHANNELS_PATH)) {
        shouldScaffoldDiscordChannels = nonInteractive
          ? parseBoolean(cli.options['write-discord-channels'], true)
          : yn(await rl.question('Create config/discord-channels.json from the example? [Y/n]: '), true);
      }
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

    const ollamaBaseUrl = await resolveText('OLLAMA_BASE_URL');
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

    const monitoringEnabled = nonInteractive
      ? parseBoolean(cli.options.monitoring, parseBoolean(existing.METRICS_ENABLED, false))
      : yn(
          await rl.question('\nEnable monitoring (Prometheus + Grafana)? [y/N]: '),
          parseBoolean(existing.METRICS_ENABLED, false),
        );

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
    const sharedEnvContent = buildSharedEnvLines(finalEnv).join('\n');

    const envTargets = [{ path: ENV_PATH, content: sharedEnvContent, label: '.env' }];
    if (messagingPlatform === 'discord') {
      envTargets.push({
        path: ENV_DISCORD_PATH,
        content: buildPlatformEnvLines('discord', finalEnv).join('\n'),
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
        mkdirSync(resolve(PROJECT_ROOT, 'config'), { recursive: true });
        writeFileSync(GROUPS_PATH, `${JSON.stringify(groupsConfig, null, 2)}\n`, 'utf-8');
        output.write('✅ Wrote config/groups.json\n');
      }
    } else if (messagingPlatform !== 'whatsapp') {
      output.write('ℹ️ Skipped groups.json generation (only needed for WhatsApp runtime).\n');
    }

    if (messagingPlatform === 'discord' && bandDeployment) {
      if (existsSync(DISCORD_CHANNELS_PATH)) {
        output.write('ℹ️ Using existing config/discord-channels.json; leaving it unchanged.\n');
      } else if (shouldScaffoldDiscordChannels) {
        if (!existsSync(DISCORD_CHANNELS_EXAMPLE_PATH)) {
          output.write('⚠️ config/discord-channels.example.json is missing; create config/discord-channels.json before starting Remy.\n');
        } else if (dryRun) {
          output.write('🧪 Dry-run: would copy config/discord-channels.example.json to config/discord-channels.json\n');
        } else {
          mkdirSync(resolve(PROJECT_ROOT, 'config'), { recursive: true });
          copyFileSync(DISCORD_CHANNELS_EXAMPLE_PATH, DISCORD_CHANNELS_PATH);
          output.write('✅ Wrote config/discord-channels.json from config/discord-channels.example.json\n');
        }
        output.write('ℹ️ Fill config/discord-channels.json with real Discord channel, role, and owner ids before starting Remy.\n');
      } else {
        output.write('ℹ️ Skipped config/discord-channels.json scaffold. Copy config/discord-channels.example.json there and fill in real Discord ids before starting Remy.\n');
      }
    }

    if (!dryRun && existsSync(resolve(PROJECT_ROOT, '.git'))) {
      copyFileSync(resolve(PROJECT_ROOT, 'scripts', 'pre-commit'), resolve(PROJECT_ROOT, '.git', 'hooks', 'pre-commit'));
      output.write('✅ Installed pre-commit hook\n');
    } else if (dryRun && existsSync(resolve(PROJECT_ROOT, '.git'))) {
      output.write('🧪 Dry-run: would install pre-commit hook\n');
    }

    output.write('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    output.write('✅ Setup complete\n');
    output.write(`- Messaging platform: ${messagingPlatform}\n`);
    output.write(`- Compose profiles: ${composeProfiles}\n`);
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
    }

    if (deployTarget === 'docker') {
      output.write('\nNext commands:\n');
      output.write('  docker compose up -d\n');
      output.write('  docker compose logs -f garbanzo\n');
    } else {
      output.write('\nNext commands:\n');
      output.write('  npm run dev\n');
    }
    output.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  output.write(`\n❌ Setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
