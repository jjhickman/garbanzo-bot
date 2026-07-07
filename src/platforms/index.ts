import { config } from '../utils/config.js';
import { createWhatsAppRuntime } from './whatsapp/runtime.js';
import { createDiscordRuntime } from './discord/runtime.js';
import { createSlackRuntime } from './slack/runtime.js';
import { createTelegramRuntime } from './telegram/runtime.js';
import type { PlatformRuntime } from './types.js';

export function getPlatformRuntime(): PlatformRuntime {
  if (config.MESSAGING_PLATFORM === 'whatsapp') return createWhatsAppRuntime();
  if (config.MESSAGING_PLATFORM === 'discord') return createDiscordRuntime();
  if (config.MESSAGING_PLATFORM === 'slack') return createSlackRuntime();
  if (config.MESSAGING_PLATFORM === 'telegram') return createTelegramRuntime();

  // matrix passes config validation (the enum groundwork lands ahead of its
  // runtime) but has no runtime yet — a clear, platform-named error beats a
  // generic "unsupported" message while the adapter is built.
  throw new Error(`Platform "${config.MESSAGING_PLATFORM}" is not available in this build yet.`);
}
