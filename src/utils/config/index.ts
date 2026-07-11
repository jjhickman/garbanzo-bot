import { existsSync } from 'fs';
import { parseConfig } from './parse-config.js';
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

for (const warning of parsed.warnings) {
  console.warn(warning);
}

if (!parsed.ok) {
  for (const error of parsed.errors) {
    console.error(error);
  }
  process.exit(1);
}

if (parsed.config.RAG_FEDERATION_ENABLED && !existsSync(homePath('config/rag-sources.json'))) {
  console.warn('⚠️ RAG_FEDERATION_ENABLED=true but config/rag-sources.json is not readable; federation disabled');
}

export const config = parsed.config;
export const instanceId = config.INSTANCE_ID ?? config.MESSAGING_PLATFORM;
export { PROJECT_ROOT };
