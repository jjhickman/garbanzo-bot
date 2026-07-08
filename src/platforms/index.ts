import { config } from '../utils/config.js';
import { createWhatsAppRuntime } from './whatsapp/runtime.js';
import { createDiscordRuntime } from './discord/runtime.js';
import { createSlackRuntime } from './slack/runtime.js';
import { createTelegramRuntime } from './telegram/runtime.js';
import { createMatrixRuntime } from './matrix/runtime.js';
import type { PlatformRuntime } from './types.js';

export function getPlatformRuntime(): PlatformRuntime {
  if (config.MESSAGING_PLATFORM === 'whatsapp') return createWhatsAppRuntime();
  if (config.MESSAGING_PLATFORM === 'discord') return createDiscordRuntime();
  if (config.MESSAGING_PLATFORM === 'slack') return createSlackRuntime();
  if (config.MESSAGING_PLATFORM === 'telegram') return createTelegramRuntime();
  if (config.MESSAGING_PLATFORM === 'matrix') return createMatrixRuntime();

  throw new Error(`Unsupported messaging platform: ${config.MESSAGING_PLATFORM}`);
}
