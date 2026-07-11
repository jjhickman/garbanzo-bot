import { randomBytes } from 'crypto';

interface NonceRecord {
  memoryId: number;
  expiresAt: number;
}

export type NonceConsumeResult = 'valid' | 'invalid' | 'expired';

export interface DeleteNonceStore {
  issue(memoryId: number): { nonce: string; expiresAt: number };
  consume(nonce: string, memoryId: number): NonceConsumeResult;
}

export function createDeleteNonceStore(
  ttlMs = 5 * 60 * 1000,
  now: () => number = Date.now,
): DeleteNonceStore {
  const records = new Map<string, NonceRecord>();

  function pruneExpired(): void {
    const current = now();
    for (const [nonce, record] of records) {
      if (record.expiresAt <= current) records.delete(nonce);
    }
  }

  return {
    issue(memoryId) {
      pruneExpired();
      const nonce = randomBytes(32).toString('hex');
      const expiresAt = now() + ttlMs;
      records.set(nonce, { memoryId, expiresAt });
      return { nonce, expiresAt };
    },

    consume(nonce, memoryId) {
      const record = records.get(nonce);
      if (!record || record.memoryId !== memoryId) return 'invalid';
      records.delete(nonce);
      if (record.expiresAt <= now()) return 'expired';
      return 'valid';
    },
  };
}
