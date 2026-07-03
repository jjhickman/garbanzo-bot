import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('pgvector path removed', () => {
  it('db-postgres.ts no longer references vector tables', () => {
    const src = readFileSync('src/utils/db-postgres.ts', 'utf-8');
    expect(src).not.toMatch(/message_vectors/);
    expect(src).not.toMatch(/conversation_session_vectors/);
  });
});
