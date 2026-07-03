import { backfillVectors } from '../dist/utils/vector-backfill.js';

try {
  const progress = await backfillVectors({
    onProgress: (current) => {
      process.stdout.write(`${JSON.stringify(current)}\n`);
    },
  });
  process.stdout.write(`Backfill complete: ${JSON.stringify(progress)}\n`);
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`Vector backfill failed: ${message}\n`);
  process.exitCode = 1;
}
