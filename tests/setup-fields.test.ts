// Unit tests for the setup wizard's field table + resolvers. The module is pure
// (no config import), so no env prefix is needed. tsconfig excludes tests/, so
// importing the .mjs here is fine.
import { describe, expect, it } from 'vitest';

import {
  getField,
  promptHint,
  resolveEnvField,
  OPENAI_AUTH_MODES,
  WHATSAPP_LOGIN_MODES,
} from '../scripts/setup-fields.mjs';

function cli(options: Record<string, string>): { options: Record<string, string>; flags: Set<string> } {
  return { options, flags: new Set<string>() };
}

describe('setup field resolver', () => {
  it('resolves non-interactive values with cli > existing > default precedence', () => {
    const field = getField('OPENAI_MODEL');
    expect(resolveEnvField(field, cli({ 'openai-model': 'gpt-x' }), { OPENAI_MODEL: 'existing' })).toBe('gpt-x');
    expect(resolveEnvField(field, cli({}), { OPENAI_MODEL: 'existing' })).toBe('existing');
    expect(resolveEnvField(field, cli({}), {})).toBe('gpt-5.4-mini');
  });

  it('masks secret fields in prompt hints, never showing the raw value', () => {
    const secret = getField('OPENAI_API_KEY');
    expect(secret.secret).toBe(true);
    expect(promptHint(secret, { OPENAI_API_KEY: 'sk-super-secret' })).toBe('set');
    expect(promptHint(secret, {})).toBe('empty');
    expect(promptHint(secret, { OPENAI_API_KEY: 'sk-super-secret' })).not.toContain('sk-');
  });

  it('shows the current value or default for non-secret fields', () => {
    const model = getField('OPENAI_MODEL');
    expect(promptHint(model, { OPENAI_MODEL: 'gpt-9' })).toBe('gpt-9');
    expect(promptHint(model, {})).toBe('gpt-5.4-mini');
  });

  it('marks every API key/token field as secret', () => {
    for (const env of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GITHUB_ISSUES_TOKEN']) {
      expect(getField(env).secret).toBe(true);
    }
    expect(getField('OPENAI_MODEL').secret).toBeUndefined();
  });

  it('exposes the new auth/login mode enums and rejects unknown fields', () => {
    expect(OPENAI_AUTH_MODES).toEqual(['apikey', 'oauth']);
    expect(WHATSAPP_LOGIN_MODES).toEqual(['web', 'terminal', 'both']);
    expect(() => getField('NOPE')).toThrow(/Unknown setup field/);
  });
});
