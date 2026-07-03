process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it } from 'vitest';
import { getCurrentStats, recordVectorSearch, recordVectorUpsert } from '../src/middleware/stats.js';

describe('vector stats', () => {
  it('counts upsert and search outcomes', () => {
    recordVectorUpsert('ok');
    recordVectorUpsert('error');
    recordVectorSearch('ok');
    recordVectorSearch('empty');
    recordVectorSearch('error');

    const snap = getCurrentStats();

    expect(snap.vectorUpsertsOk).toBeGreaterThanOrEqual(1);
    expect(snap.vectorUpsertFailures).toBeGreaterThanOrEqual(1);
    expect(snap.vectorSearchesOk).toBeGreaterThanOrEqual(2);
    expect(snap.vectorSearchFailures).toBeGreaterThanOrEqual(1);
  });
});
