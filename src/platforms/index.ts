import { config } from '../utils/config.js';
import { createWhatsAppRuntime } from './whatsapp/runtime.js';
import { createDiscordRuntime } from './discord/runtime.js';
import type { PlatformRuntime } from './types.js';

export function getPlatformRuntime(): PlatformRuntime {
  if (config.MESSAGING_PLATFORM === 'whatsapp') return createWhatsAppRuntime();
  if (config.MESSAGING_PLATFORM === 'discord') return createDiscordRuntime();

  // Future platforms are reserved in docs/config; runtime not yet implemented.
  throw new Error(`Unsupported platform runtime: ${config.MESSAGING_PLATFORM}`);
}
