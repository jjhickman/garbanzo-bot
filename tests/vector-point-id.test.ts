import { describe, expect, it } from 'vitest';
import { vectorPointId } from '../src/utils/vector-point-id.js';

describe('vectorPointId', () => {
  it('is deterministic for the same kind + refId', () => {
    expect(vectorPointId('message', '42')).toBe(vectorPointId('message', '42'));
  });

  it('differs by kind and by refId', () => {
    expect(vectorPointId('message', '42')).not.toBe(vectorPointId('session', '42'));
    expect(vectorPointId('message', '42')).not.toBe(vectorPointId('message', '43'));
  });

  it('returns a canonical UUID string (Qdrant-compatible id)', () => {
    expect(vectorPointId('fact', '7')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
