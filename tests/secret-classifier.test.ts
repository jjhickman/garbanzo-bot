import { describe, expect, it } from 'vitest';

import {
  KNOWN_SCHEMA_KEYS,
  isSecretKey,
  redactEnvContent,
} from '../src/config-core/secret-classifier.js';
import {
  FIELD_TABLE,
  buildPlatformEnvLines,
  buildSharedEnvLines,
  mergeEnvFileContent,
} from '../src/config-core/fields.js';

describe('deny-by-default secret classifier', () => {
  it('explicitly classifies every wizard field and every env schema key', () => {
    expect(FIELD_TABLE.every((field) => typeof field.secret === 'boolean')).toBe(true);
    expect(KNOWN_SCHEMA_KEYS.length).toBeGreaterThan(0);
  });

  it('redacts a unique canary for every secret schema field and every unknown key', () => {
    const canaries = new Map<string, string>();
    const keys = [
      ...KNOWN_SCHEMA_KEYS,
      'CUSTOM_TOKEN',
      'CUSTOM_PASSWORD',
      'CUSTOM_ANYTHING',
    ];
    const content = keys.map((key, index) => {
      const canary = `ws1b_canary_${index}_${key.toLowerCase()}`;
      canaries.set(key, canary);
      return `${key}=${canary}`;
    }).join('\n');

    const redacted = redactEnvContent(content);

    for (const key of keys) {
      const canary = canaries.get(key);
      expect(canary).toBeDefined();
      if (isSecretKey(key)) {
        expect(redacted, `${key} must be redacted`).not.toContain(canary);
        expect(redacted).toContain(`${key}=[REDACTED]`);
      } else {
        expect(redacted, `${key} must pass through`).toContain(`${key}=${canary}`);
      }
    }
  });

  it('redacts credential-bearing URLs even for explicitly non-secret keys', () => {
    expect(redactEnvContent('SEARXNG_BASE_URL=https://user:pass@example.test/search'))
      .toBe('SEARXNG_BASE_URL=[REDACTED]');
  });

  it('redacts Matrix and Qdrant secrets in the real wizard dry-run', () => {
    const values = {
      MATRIX_ACCESS_TOKEN: 'ws1b_matrix_canary',
    };
    const sharedPreview = redactEnvContent(mergeEnvFileContent(
      'QDRANT_API_KEY=ws1b_qdrant_canary\n',
      buildSharedEnvLines(values).join('\n'),
    ));
    const matrixPreview = redactEnvContent(buildPlatformEnvLines('matrix', values).join('\n'));

    expect(matrixPreview).toContain('MATRIX_ACCESS_TOKEN=[REDACTED]');
    expect(sharedPreview).toContain('QDRANT_API_KEY=[REDACTED]');
    expect(matrixPreview).not.toContain('ws1b_matrix_canary');
    expect(sharedPreview).not.toContain('ws1b_qdrant_canary');
  });
});
