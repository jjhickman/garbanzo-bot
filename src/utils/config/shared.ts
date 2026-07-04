import { existsSync } from 'fs';
import { resolve } from 'path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const DEFAULT_MESSAGING_PLATFORM = 'discord';

export type EnvLayerResult = {
  env: NodeJS.ProcessEnv;
  loadedEnvFiles: string[];
  platform: string;
};

export type EnvLayerOptions = {
  baseDir: string;
  env?: NodeJS.ProcessEnv;
  realEnv: NodeJS.ProcessEnv;
  platform?: string;
};

function restoreRealEnv(env: NodeJS.ProcessEnv, realEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(realEnv)) {
    const value = realEnv[key];
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}

export function applyEnvLayers(options: EnvLayerOptions): EnvLayerResult {
  const env = options.env ?? process.env;
  const loadedEnvFiles: string[] = [];

  const loadFile = (path: string, override: boolean): void => {
    if (!existsSync(path)) return;
    loadDotenv({ path, override, processEnv: env });
    loadedEnvFiles.push(path);
    restoreRealEnv(env, options.realEnv);
  };

  loadFile(resolve(options.baseDir, '.env'), false);

  const platform = options.platform ?? env.MESSAGING_PLATFORM ?? DEFAULT_MESSAGING_PLATFORM;
  loadFile(resolve(options.baseDir, `.env.${platform}`), true);

  restoreRealEnv(env, options.realEnv);

  return { env, loadedEnvFiles, platform };
}

export const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

export const optionalString = z.preprocess(
  (value) => {
    if (typeof value === 'string' && value.trim() === '') return undefined;
    if (typeof value === 'string') return value.trim();
    return value;
  },
  z.string().min(1).optional(),
);

export const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off', ''].includes(normalized)) return false;
  }
  return value;
}, z.boolean());
