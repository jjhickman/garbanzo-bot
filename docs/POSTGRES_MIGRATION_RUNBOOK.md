# Postgres Migration Runbook
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


This runbook is for Phase 1 validation when moving from local sqlite to Postgres.

## Preconditions

- `DATABASE_URL` points to an empty Postgres database.
- Local sqlite DB exists at `data/garbanzo.db` (or set `SQLITE_PATH`).
- You can run Docker locally (or have a reachable Postgres instance).

## Dry-Run Checklist

1. Initialize schema:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:postgres:init
```

2. Migrate sqlite data:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:sqlite:migrate:postgres
```

3. Verify table row counts:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run db:sqlite:verify:postgres
```

4. Run backend parity tests:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/garbanzo npm run test:postgres
```

5. Run full regression checks:

```bash
npm run typecheck
npm run lint
npm run test
```

## CI Coverage

- `.github/workflows/ci.yml` includes a `postgres-backend` job.
- The job boots Postgres 16, initializes schema, and runs `npm run test:postgres`.

## Notes

- `backupDatabase()` in postgres mode is advisory and returns a marker string.
- Real backup/restore should be managed by platform snapshots (`RDS` snapshots or `pg_dump`).
