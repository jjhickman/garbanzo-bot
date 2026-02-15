import type { DbBackend } from './db-backend.js';

/**
 * Postgres backend skeleton.
 *
 * This is intentionally not implemented yet. It's here to establish file layout
 * and to keep the eventual Postgres migration incremental.
 */
export function createPostgresBackend(): DbBackend {
  throw new Error(
    'Postgres backend is not implemented yet. Set DB_DIALECT=sqlite for now (see docs/SCALING.md).',
  );
}
