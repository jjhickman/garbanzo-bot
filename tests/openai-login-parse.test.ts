import { describe, expect, it } from 'vitest';

// @ts-expect-error - .mjs script without types; importing the pure parser only.
import { parseCallbackInput } from '../scripts/openai-login.mjs';

describe('parseCallbackInput (paste-back OAuth capture)', () => {
  const STATE = 'expected-state-123';

  it('returns null for empty / whitespace input', () => {
    expect(parseCallbackInput('', STATE)).toBeNull();
    expect(parseCallbackInput('   \n', STATE)).toBeNull();
  });

  it('extracts code from a full redirect URL and validates state', () => {
    const url = `http://localhost:1455/auth/callback?code=abc123&state=${STATE}`;
    expect(parseCallbackInput(url, STATE)).toEqual({ code: 'abc123', stateChecked: true });
  });

  it('extracts code from a bare query string', () => {
    expect(parseCallbackInput(`code=xyz&state=${STATE}`, STATE)).toEqual({ code: 'xyz', stateChecked: true });
    expect(parseCallbackInput(`?code=xyz&state=${STATE}`, STATE)).toEqual({ code: 'xyz', stateChecked: true });
  });

  it('accepts a bare code (no state to check)', () => {
    expect(parseCallbackInput('rawcode456', STATE)).toEqual({ code: 'rawcode456', stateChecked: false });
  });

  it('rejects a state mismatch (CSRF guard)', () => {
    const url = `http://localhost:1455/auth/callback?code=abc&state=wrong`;
    expect(() => parseCallbackInput(url, STATE)).toThrow(/State mismatch/);
  });

  it('rejects a missing code in a structured URL', () => {
    expect(() => parseCallbackInput(`http://localhost:1455/auth/callback?state=${STATE}`, STATE)).toThrow(/No "code"/);
  });

  it('surfaces an OAuth error param', () => {
    expect(() => parseCallbackInput('http://localhost:1455/auth/callback?error=access_denied', STATE)).toThrow(
      /Authorization error: access_denied/,
    );
  });
});
