import { describe, expect, it } from 'vitest';
import { config } from '../src/utils/config.js';

/**
 * Session backfill tests.
 *
 * The backfill module connects directly to Postgres, so full integration
 * tests require a running database. These tests validate the module can
 * be imported and handles the sqlite-dialect guard correctly.
 */

describe('session backfill module', () => {
  it('exports backfillSessionEmbeddings function', async () => {
    const mod = await import('../src/utils/session-backfill.js');
    expect(typeof mod.backfillSessionEmbeddings).toBe('function');
  });

  it('returns empty progress on sqlite dialect', async () => {
    const originalDialect = config.DB_DIALECT;
    try {
      (config as Record<string, unknown>).DB_DIALECT = 'sqlite';
      const { backfillSessionEmbeddings } = await import('../src/utils/session-backfill.js');
      const progress = await backfillSessionEmbeddings();

      expect(progress.total).toBe(0);
      expect(progress.processed).toBe(0);
      expect(progress.succeeded).toBe(0);
      expect(progress.failed).toBe(0);
      expect(progress.skipped).toBe(0);
    } finally {
      (config as Record<string, unknown>).DB_DIALECT = originalDialect;
    }
  });
});
