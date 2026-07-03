process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it } from 'vitest';

import type { MessagingPlatform } from '../src/core/messaging-platform.js';
import { shouldEnableWhatsAppLogin } from '../src/platforms/whatsapp/login-url.js';

type WhatsAppLoginMode = 'web' | 'terminal' | 'both';

describe('shouldEnableWhatsAppLogin', () => {
  it.each([
    ['whatsapp', 'web', false, true],
    ['whatsapp', 'both', false, true],
    ['whatsapp', 'terminal', false, false],
    ['whatsapp', 'web', true, false],
    ['discord', 'web', false, false],
    ['discord', 'both', false, false],
    ['slack', 'web', false, false],
    ['teams', 'web', false, false],
  ] satisfies Array<[MessagingPlatform, WhatsAppLoginMode, boolean, boolean]>)(
    'platform=%s loginMode=%s healthOnlyMode=%s -> %s',
    (platform, loginMode, healthOnlyMode, expected) => {
      expect(shouldEnableWhatsAppLogin(platform, loginMode, healthOnlyMode)).toBe(expected);
    },
  );
});
