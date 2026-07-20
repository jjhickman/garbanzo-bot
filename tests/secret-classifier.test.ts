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

  it('classifies bridge media controls as non-secret', () => {
    expect(isSecretKey('BRIDGE_MEDIA_ENABLED')).toBe(false);
    expect(isSecretKey('BRIDGE_MEDIA_MAX_BYTES')).toBe(false);
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

  it('redacts complete logical dotenv records and preserves surrounding records', () => {
    const content = [
      'export OPENAI_API_KEY="alpha',
      'beta"',
      'OPENAI_MODEL="gpt-5.4-mini" # keep this comment',
      'OPENAI_API_KEY="quoted-canary" # preserve this comment',
      'SUPPORT_MESSAGE="say \\"hello\\" safely"',
      'SEARXNG_BASE_URL="https://user:pass@example.test/search"',
      'OLLAMA_BASE_URL=https://example.test/search?api_key=query-canary',
      'LOG_LEVEL=info',
    ].join('\r\n');

    const redacted = redactEnvContent(content);

    expect(redacted).toBe([
      'export OPENAI_API_KEY=[REDACTED]',
      'OPENAI_MODEL="gpt-5.4-mini" # keep this comment',
      'OPENAI_API_KEY=[REDACTED] # preserve this comment',
      'SUPPORT_MESSAGE="say \\"hello\\" safely"',
      'SEARXNG_BASE_URL=[REDACTED]',
      'OLLAMA_BASE_URL=[REDACTED]',
      'LOG_LEVEL=info',
    ].join('\r\n'));
    expect(redacted).not.toContain('alpha');
    expect(redacted).not.toContain('beta');
    expect(redacted).not.toContain('query-canary');
    expect(redacted).not.toContain('quoted-canary');
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
