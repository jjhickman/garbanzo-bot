import { describe, expect, it } from 'vitest';

import { isSecretKey } from '../src/config-core/secret-classifier.js';
import { monitoringSchema } from '../src/utils/config/monitoring.js';
import { parseConfig } from '../src/utils/config/parse-config.js';

describe('admin write configuration', () => {
  it('is disabled and loopback-bound by default', () => {
    const parsed = monitoringSchema.parse({});

    expect(parsed.ADMIN_WRITE_ENABLED).toBe(false);
    expect(parsed.ADMIN_WRITE_TOKEN).toBeUndefined();
    expect(parsed.ADMIN_WRITE_PORT).toBe(3006);
    expect(parsed.ADMIN_WRITE_BIND_HOST).toBe('127.0.0.1');
  });

  it('requires a token of at least 16 characters when enabled', () => {
    const base = {
      MESSAGING_PLATFORM: 'discord',
      OPENROUTER_API_KEY: 'test_key_ci',
      AI_PROVIDER_ORDER: 'openrouter',
    };
    expect(parseConfig({ ...base, ADMIN_WRITE_ENABLED: 'true' }).ok).toBe(false);
    expect(monitoringSchema.safeParse({
      ADMIN_WRITE_ENABLED: 'true',
      ADMIN_WRITE_TOKEN: 'too-short',
    }).success).toBe(false);
    expect(monitoringSchema.safeParse({
      ADMIN_WRITE_ENABLED: 'true',
      ADMIN_WRITE_TOKEN: 'admin_test_token_1234',
    }).success).toBe(true);
  });

  it('classifies ADMIN_WRITE_TOKEN as a secret', () => {
    expect(isSecretKey('ADMIN_WRITE_TOKEN')).toBe(true);
  });
});
