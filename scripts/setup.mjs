#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execSync } from 'node:child_process';

const PROJECT_ROOT = resolve(new URL('..', import.meta.url).pathname);
const ENV_PATH = resolve(PROJECT_ROOT, '.env');
const GROUPS_PATH = resolve(PROJECT_ROOT, 'config', 'groups.json');
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

function redactEnvContent(content) {
  const redactPrefixes = [
    'ANTHROPIC_API_KEY=',
    'OPENROUTER_API_KEY=',
    'OPENAI_API_KEY=',
    'GEMINI_API_KEY=',
    'GITHUB_ISSUES_TOKEN=',
    'OWNER_JID=',
    'BOT_PHONE_NUMBER=',
  ];

  return content
    .split('\n')
    .map((line) => {
      const prefix = redactPrefixes.find((candidate) => line.startsWith(candidate));
      if (!prefix) return line;
      const value = line.slice(prefix.length).trim();
      return value ? `${prefix}[REDACTED]` : line;
    })
    .join('\n');
}

function yn(value, fallback = true) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['y', 'yes'].includes(normalized)) return true;
  if (['n', 'no'].includes(normalized)) return false;
  return fallback;
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
    output.write('  npm run setup -- --non-interactive --providers=gemini --gemini-key=$GEMINI_API_KEY --gemini-model=gemini-1.5-flash --gemini-pricing-input-per-m=0.15 --gemini-pricing-output-per-m=0.60\n');
    output.write('  npm run setup -- --non-interactive --profile=events --features=weather,transit,events,venues,poll --group-id=120...@g.us --group-name="Events"\n');
    output.write('  npm run setup -- --non-interactive --persona-file=./my-persona.md --owner-jid=your_number@s.whatsapp.net\n');
    output.write('  npm run setup -- --non-interactive --app-version=0.2.0 --github-issues-repo=jjhickman/garbanzo-bot --github-issues-token=$GITHUB_ISSUES_TOKEN\n');
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
  const existing = parseEnvFile(ENV_PATH);

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

    let messagingPlatform = 'whatsapp';
    if (nonInteractive) {
      const requestedPlatform = (cli.options.platform || existing.MESSAGING_PLATFORM || 'whatsapp').trim().toLowerCase();
      messagingPlatform = ['whatsapp', 'discord', 'slack', 'teams'].includes(requestedPlatform)
        ? requestedPlatform
        : 'whatsapp';
    } else {
      const platformIndex = await promptChoice(
        rl,
        'Messaging platform:',
        [
          'WhatsApp (supported now)',
          'Slack (planned; runtime support pending)',
          'Teams (planned; runtime support pending)',
          'Discord (planned; runtime support pending)',
        ],
        existing.MESSAGING_PLATFORM === 'slack'
          ? 1
          : existing.MESSAGING_PLATFORM === 'teams'
            ? 2
            : existing.MESSAGING_PLATFORM === 'discord'
              ? 3
              : 0,
      );
      messagingPlatform = platformIndex === 1
        ? 'slack'
        : platformIndex === 2
          ? 'teams'
          : platformIndex === 3
            ? 'discord'
            : 'whatsapp';
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

    if (nonInteractive) {
      const providerCsv = cli.options.providers || cli.options.provider || '';
      if (providerCsv) {
        const providers = parseCsv(providerCsv).map((p) => p.toLowerCase());
        useOpenRouter = providers.includes('openrouter');
        useAnthropic = providers.includes('anthropic');
        useOpenAI = providers.includes('openai');
        useGemini = providers.includes('gemini');
      } else {
        useOpenRouter = parseBoolean(cli.options['use-openrouter'], !!existing.OPENROUTER_API_KEY);
        useAnthropic = parseBoolean(cli.options['use-anthropic'], !!existing.ANTHROPIC_API_KEY);
        useOpenAI = parseBoolean(cli.options['use-openai'], !!existing.OPENAI_API_KEY);
        useGemini = parseBoolean(cli.options['use-gemini'], !!existing.GEMINI_API_KEY);
      }
    } else {
      useOpenRouter = yn(await rl.question(`Use OpenRouter Claude? [Y/n] (current: ${existing.OPENROUTER_API_KEY ? 'set' : 'empty'}): `), true);
      useAnthropic = yn(await rl.question(`Use Anthropic direct Claude? [Y/n] (current: ${existing.ANTHROPIC_API_KEY ? 'set' : 'empty'}): `), true);
      useOpenAI = yn(await rl.question(`Use OpenAI? [Y/n] (current: ${existing.OPENAI_API_KEY ? 'set' : 'empty'}): `), true);
      useGemini = yn(await rl.question(`Use Google Gemini? [y/N] (current: ${existing.GEMINI_API_KEY ? 'set' : 'empty'}): `), false);
    }

    if (!useOpenRouter && !useAnthropic && !useOpenAI && !useGemini) {
      output.write('⚠️ No provider selected, enabling OpenAI fallback by default.\n');
      useOpenAI = true;
    }

    const selectedProviders = [];
    if (useOpenRouter) selectedProviders.push('openrouter');
    if (useAnthropic) selectedProviders.push('anthropic');
    if (useOpenAI) selectedProviders.push('openai');
    if (useGemini) selectedProviders.push('gemini');

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

    const anthropicKey = useAnthropic
      ? (nonInteractive
          ? (cli.options['anthropic-key'] ?? existing.ANTHROPIC_API_KEY ?? '')
          : await rl.question(`ANTHROPIC_API_KEY [${existing.ANTHROPIC_API_KEY ?? ''}]: `))
      : '';
    const openRouterKey = useOpenRouter
      ? (nonInteractive
          ? (cli.options['openrouter-key'] ?? existing.OPENROUTER_API_KEY ?? '')
          : await rl.question(`OPENROUTER_API_KEY [${existing.OPENROUTER_API_KEY ?? ''}]: `))
      : '';
    const openAIKey = useOpenAI
      ? (nonInteractive
          ? (cli.options['openai-key'] ?? existing.OPENAI_API_KEY ?? '')
          : await rl.question(`OPENAI_API_KEY [${existing.OPENAI_API_KEY ?? ''}]: `))
      : '';
    const geminiKey = useGemini
      ? (nonInteractive
          ? (cli.options['gemini-key'] ?? existing.GEMINI_API_KEY ?? '')
          : await rl.question(`GEMINI_API_KEY [${existing.GEMINI_API_KEY ?? ''}]: `))
      : '';

    const anthropicModel = nonInteractive
      ? (cli.options['anthropic-model'] ?? existing.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250514')
      : await rl.question(`ANTHROPIC_MODEL [${existing.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250514'}]: `);
    const openRouterModel = nonInteractive
      ? (cli.options['openrouter-model'] ?? existing.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4-5')
      : await rl.question(`OPENROUTER_MODEL [${existing.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4-5'}]: `);
    const openAIModel = nonInteractive
      ? (cli.options['openai-model'] ?? existing.OPENAI_MODEL ?? 'gpt-4.1')
      : await rl.question(`OPENAI_MODEL [${existing.OPENAI_MODEL ?? 'gpt-4.1'}]: `);
    const geminiModel = nonInteractive
      ? (cli.options['gemini-model'] ?? existing.GEMINI_MODEL ?? 'gemini-1.5-flash')
      : await rl.question(`GEMINI_MODEL [${existing.GEMINI_MODEL ?? 'gemini-1.5-flash'}]: `);

    const geminiPricingInputPerM = nonInteractive
      ? (cli.options['gemini-pricing-input-per-m'] ?? existing.GEMINI_PRICING_INPUT_PER_M ?? '0')
      : await rl.question(`GEMINI_PRICING_INPUT_PER_M (USD per 1M tokens) [${existing.GEMINI_PRICING_INPUT_PER_M ?? '0'}]: `);
    const geminiPricingOutputPerM = nonInteractive
      ? (cli.options['gemini-pricing-output-per-m'] ?? existing.GEMINI_PRICING_OUTPUT_PER_M ?? '0')
      : await rl.question(`GEMINI_PRICING_OUTPUT_PER_M (USD per 1M tokens) [${existing.GEMINI_PRICING_OUTPUT_PER_M ?? '0'}]: `);

    const ollamaBaseUrl = nonInteractive
      ? (cli.options['ollama-base-url'] ?? existing.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434')
      : await rl.question(`OLLAMA_BASE_URL [${existing.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'}]: `);
    const ownerJid = nonInteractive
      ? (cli.options['owner-jid'] ?? existing.OWNER_JID ?? 'your_number@s.whatsapp.net')
      : await rl.question(`OWNER_JID [${existing.OWNER_JID ?? 'your_number@s.whatsapp.net'}]: `);
    const appVersion = nonInteractive
      ? (cli.options['app-version'] ?? existing.APP_VERSION ?? DEFAULT_APP_VERSION)
      : await rl.question(`APP_VERSION [${existing.APP_VERSION ?? DEFAULT_APP_VERSION}]: `);
    const healthPort = nonInteractive
      ? (cli.options['health-port'] ?? existing.HEALTH_PORT ?? '3001')
      : await rl.question(`HEALTH_PORT [${existing.HEALTH_PORT ?? '3001'}]: `);
    const healthBindHost = nonInteractive
      ? (cli.options['health-bind-host'] ?? existing.HEALTH_BIND_HOST ?? '127.0.0.1')
      : await rl.question(`HEALTH_BIND_HOST [${existing.HEALTH_BIND_HOST ?? '127.0.0.1'}]: `);

    const githubSponsorsUrl = nonInteractive
      ? (cli.options['github-sponsors-url'] ?? existing.GITHUB_SPONSORS_URL ?? '')
      : await rl.question(`GITHUB_SPONSORS_URL [${existing.GITHUB_SPONSORS_URL ?? ''}]: `);
    const patreonUrl = nonInteractive
      ? (cli.options['patreon-url'] ?? existing.PATREON_URL ?? '')
      : await rl.question(`PATREON_URL [${existing.PATREON_URL ?? ''}]: `);
    const kofiUrl = nonInteractive
      ? (cli.options['kofi-url'] ?? existing.KOFI_URL ?? '')
      : await rl.question(`KOFI_URL [${existing.KOFI_URL ?? ''}]: `);
    const supportCustomUrl = nonInteractive
      ? (cli.options['support-custom-url'] ?? existing.SUPPORT_CUSTOM_URL ?? '')
      : await rl.question(`SUPPORT_CUSTOM_URL [${existing.SUPPORT_CUSTOM_URL ?? ''}]: `);
    const supportMessage = nonInteractive
      ? (cli.options['support-message'] ?? existing.SUPPORT_MESSAGE ?? '')
      : await rl.question(`SUPPORT_MESSAGE [${existing.SUPPORT_MESSAGE ?? ''}]: `);
    const githubIssuesToken = nonInteractive
      ? (cli.options['github-issues-token'] ?? existing.GITHUB_ISSUES_TOKEN ?? '')
      : await rl.question(`GITHUB_ISSUES_TOKEN [${existing.GITHUB_ISSUES_TOKEN ?? ''}]: `);
    const githubIssuesRepo = nonInteractive
      ? (cli.options['github-issues-repo'] ?? existing.GITHUB_ISSUES_REPO ?? 'jjhickman/garbanzo-bot')
      : await rl.question(`GITHUB_ISSUES_REPO [${existing.GITHUB_ISSUES_REPO ?? 'jjhickman/garbanzo-bot'}]: `);

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

    const finalEnv = {
      MESSAGING_PLATFORM: messagingPlatform,
      ANTHROPIC_API_KEY: (anthropicKey || existing.ANTHROPIC_API_KEY || '').trim(),
      OPENROUTER_API_KEY: (openRouterKey || existing.OPENROUTER_API_KEY || '').trim(),
      OPENAI_API_KEY: (openAIKey || existing.OPENAI_API_KEY || '').trim(),
      GEMINI_API_KEY: (geminiKey || existing.GEMINI_API_KEY || '').trim(),
      AI_PROVIDER_ORDER: aiProviderOrder,
      ANTHROPIC_MODEL: (anthropicModel || existing.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250514').trim(),
      OPENROUTER_MODEL: (openRouterModel || existing.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5').trim(),
      OPENAI_MODEL: (openAIModel || existing.OPENAI_MODEL || 'gpt-4.1').trim(),
      GEMINI_MODEL: (geminiModel || existing.GEMINI_MODEL || 'gemini-1.5-flash').trim(),
      GEMINI_PRICING_INPUT_PER_M: String(geminiPricingInputPerM || existing.GEMINI_PRICING_INPUT_PER_M || '0').trim(),
      GEMINI_PRICING_OUTPUT_PER_M: String(geminiPricingOutputPerM || existing.GEMINI_PRICING_OUTPUT_PER_M || '0').trim(),
      BOT_PHONE_NUMBER: (existing.BOT_PHONE_NUMBER || '').trim(),
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
      GITHUB_ISSUES_REPO: (githubIssuesRepo || existing.GITHUB_ISSUES_REPO || 'jjhickman/garbanzo-bot').trim(),
      OLLAMA_BASE_URL: (ollamaBaseUrl || existing.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim(),
      LOG_LEVEL: (existing.LOG_LEVEL || 'info').trim(),
      APP_VERSION: (appVersion || existing.APP_VERSION || DEFAULT_APP_VERSION).trim(),
      HEALTH_PORT: (healthPort || existing.HEALTH_PORT || '3001').trim(),
      HEALTH_BIND_HOST: (healthBindHost || existing.HEALTH_BIND_HOST || '127.0.0.1').trim(),
      OWNER_JID: (ownerJid || existing.OWNER_JID || 'your_number@s.whatsapp.net').trim(),
    };

    const envContent = [
      '# Garbanzo generated by setup wizard',
      `MESSAGING_PLATFORM=${finalEnv.MESSAGING_PLATFORM}`,
      '',
      '# Cloud providers (runtime failover follows AI_PROVIDER_ORDER)',
      `ANTHROPIC_API_KEY=${finalEnv.ANTHROPIC_API_KEY}`,
      `OPENROUTER_API_KEY=${finalEnv.OPENROUTER_API_KEY}`,
      `OPENAI_API_KEY=${finalEnv.OPENAI_API_KEY}`,
      `GEMINI_API_KEY=${finalEnv.GEMINI_API_KEY}`,
      `AI_PROVIDER_ORDER=${finalEnv.AI_PROVIDER_ORDER}`,
      `ANTHROPIC_MODEL=${finalEnv.ANTHROPIC_MODEL}`,
      `OPENROUTER_MODEL=${finalEnv.OPENROUTER_MODEL}`,
      `OPENAI_MODEL=${finalEnv.OPENAI_MODEL}`,
      `GEMINI_MODEL=${finalEnv.GEMINI_MODEL}`,
      `GEMINI_PRICING_INPUT_PER_M=${finalEnv.GEMINI_PRICING_INPUT_PER_M}`,
      `GEMINI_PRICING_OUTPUT_PER_M=${finalEnv.GEMINI_PRICING_OUTPUT_PER_M}`,
      '',
      '# Messaging and bot identity',
      `BOT_PHONE_NUMBER=${finalEnv.BOT_PHONE_NUMBER}`,
      `OWNER_JID=${finalEnv.OWNER_JID}`,
      '',
      '# Optional feature APIs',
      `GOOGLE_API_KEY=${finalEnv.GOOGLE_API_KEY}`,
      `MBTA_API_KEY=${finalEnv.MBTA_API_KEY}`,
      `NEWSAPI_KEY=${finalEnv.NEWSAPI_KEY}`,
      `BRAVE_SEARCH_API_KEY=${finalEnv.BRAVE_SEARCH_API_KEY}`,
      '',
      '# Optional support links',
      `GITHUB_SPONSORS_URL=${finalEnv.GITHUB_SPONSORS_URL}`,
      `PATREON_URL=${finalEnv.PATREON_URL}`,
      `KOFI_URL=${finalEnv.KOFI_URL}`,
      `SUPPORT_CUSTOM_URL=${finalEnv.SUPPORT_CUSTOM_URL}`,
      `SUPPORT_MESSAGE=${finalEnv.SUPPORT_MESSAGE}`,
      `GITHUB_ISSUES_TOKEN=${finalEnv.GITHUB_ISSUES_TOKEN}`,
      `GITHUB_ISSUES_REPO=${finalEnv.GITHUB_ISSUES_REPO}`,
      '',
      '# Runtime',
      `OLLAMA_BASE_URL=${finalEnv.OLLAMA_BASE_URL}`,
      `LOG_LEVEL=${finalEnv.LOG_LEVEL}`,
      `APP_VERSION=${finalEnv.APP_VERSION}`,
      `HEALTH_PORT=${finalEnv.HEALTH_PORT}`,
      `HEALTH_BIND_HOST=${finalEnv.HEALTH_BIND_HOST}`,
      '',
    ].join('\n');

    if (dryRun) {
      output.write('\n🧪 Dry-run: would write .env with these contents:\n');
      output.write('--- .env (preview) ---\n');
      output.write(`${redactEnvContent(envContent)}\n`);
      output.write('--- end .env preview ---\n');
    } else {
      if (existsSync(ENV_PATH)) {
        copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
        output.write(`\n🗂️ Existing .env backed up to .env.bak\n`);
      }
      writeFileSync(ENV_PATH, envContent, 'utf-8');
      output.write('✅ Wrote .env\n');
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

    if (!dryRun && existsSync(resolve(PROJECT_ROOT, '.git'))) {
      copyFileSync(resolve(PROJECT_ROOT, 'scripts', 'pre-commit'), resolve(PROJECT_ROOT, '.git', 'hooks', 'pre-commit'));
      output.write('✅ Installed pre-commit hook\n');
    } else if (dryRun && existsSync(resolve(PROJECT_ROOT, '.git'))) {
      output.write('🧪 Dry-run: would install pre-commit hook\n');
    }

    output.write('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    output.write('✅ Setup complete\n');
    output.write(`- Messaging platform: ${messagingPlatform}\n`);
    output.write(`- Cloud provider order: ${aiProviderOrder}\n`);
    output.write(`- Feature profile: ${selectedProfile.label}\n`);
    output.write(`- Enabled features: ${selectedFeatures.join(', ')}\n`);
    output.write(`- Persona source: ${customPersonaContent ? customPersonaSourcePath : 'existing docs/PERSONA.md'}\n`);
    output.write(`- Deploy target: ${deployTarget === 'docker' ? 'docker compose' : 'native node'}\n`);
    output.write(`- Write mode: ${dryRun ? 'preview only' : 'write files'}\n`);

    if (messagingPlatform === 'discord') {
      output.write('\n⚠️ Discord runtime support is planned but not implemented yet.\n');
      output.write('   Current runtime supports WhatsApp only.\n');
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
