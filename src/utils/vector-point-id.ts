import { createHash } from 'crypto';

/** Fixed namespace so ids are stable across runs. */
const NAMESPACE = 'garbanzo-vector-memory-v1';

/**
 * Derive a deterministic, Qdrant-compatible UUID from a memory kind and the
 * canonical row id. Same input → same id, so upserts overwrite in place.
 */
export function vectorPointId(kind: 'message' | 'session' | 'fact', refId: string): string {
  const hash = createHash('sha1').update(`${NAMESPACE}:${kind}:${refId}`).digest('hex');
  // Format 16 bytes of the digest as a v5-style UUID.
  const h = hash.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}
