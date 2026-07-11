import { existsSync } from 'fs';
import { parseConfig } from './parse-config.js';
import { ragSchema } from './rag.js';
import { applyEnvLayers } from './shared.js';
import { GARBANZO_HOME_DIR, PACKAGE_ROOT, homePath } from '../paths.js';

// PROJECT_ROOT is retained as an alias of PACKAGE_ROOT so existing imports
// keep compiling; new call sites should prefer assetPath()/homePath() from
// utils/paths.js directly.
const PROJECT_ROOT = PACKAGE_ROOT;

const realEnv = { ...process.env };
const envLayerResult = applyEnvLayers({ baseDir: GARBANZO_HOME_DIR, realEnv });
export const loadedEnvFiles = envLayerResult.loadedEnvFiles;

const parsed = parseConfig(process.env);

const ragEnabled = ragSchema.shape.RAG_FEDERATION_ENABLED.safeParse(process.env.RAG_FEDERATION_ENABLED);
if (ragEnabled.success && ragEnabled.data && !existsSync(homePath('config/rag-sources.json'))) {
  console.warn('⚠️ RAG_FEDERATION_ENABLED=true but config/rag-sources.json is not readable; federation disabled');
}

if (!parsed.ok) {
  const schemaIssues = parsed.issues.filter((issue) => issue.source === 'schema' && issue.severity === 'error');
  const semanticIssues = parsed.issues.filter((issue) => issue.source === 'semantic' && issue.severity === 'error');
  const errors = schemaIssues.length > 0
    ? [
      'Invalid environment variables:',
      '  Offending variables:',
      ...schemaIssues.map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`),
      '  Run `npm run setup` to create or repair your .env file.',
    ]
    : [];
  for (const issue of semanticIssues) {
    const [summary = issue.message, ...details] = issue.message.split('\n');
    errors.push(`❌ ${summary}`, ...details.map((detail) => `   ${detail}`));
  }
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

export const config = parsed.config;
export const instanceId = config.INSTANCE_ID ?? config.MESSAGING_PLATFORM;
export { PROJECT_ROOT };
