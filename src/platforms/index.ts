import { config } from '../utils/config.js';
import { createWhatsAppRuntime } from './whatsapp/runtime.js';
import { createDiscordRuntime } from './discord/runtime.js';
import { createSlackRuntime } from './slack/runtime.js';
import type { PlatformRuntime } from './types.js';

export function getPlatformRuntime(): PlatformRuntime {
  if (config.MESSAGING_PLATFORM === 'whatsapp') return createWhatsAppRuntime();
  if (config.MESSAGING_PLATFORM === 'discord') return createDiscordRuntime();
  if (config.MESSAGING_PLATFORM === 'slack') return createSlackRuntime();

  // telegram/matrix pass config validation (the enum groundwork lands ahead
  // of their runtimes) but have no runtime yet — a clear, platform-named
  // error beats a generic "unsupported" message while the adapters are built.
  throw new Error(`Platform "${config.MESSAGING_PLATFORM}" is not available in this build yet.`);
}
