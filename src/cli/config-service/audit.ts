import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isSecretKey } from '../../config-core/secret-classifier.js';
import { writeJsonWithBackupAtomic } from '../../config-core/writers.js';

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;

export type AuditChange = { key: string; before?: unknown; after?: unknown };

export function appendConfigAudit(root: string, entry: {
  action: string;
  target: string;
  changes: AuditChange[];
  sourceIp?: string;
}): void {
  const path = resolve(root, 'data', 'config-audit.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && statSync(path).size >= MAX_AUDIT_BYTES) {
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
  }
  const changes = entry.changes.map((change) => isSecretKey(change.key)
    ? { key: change.key, value: 'changed' }
    : change);
  appendFileSync(path, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    action: entry.action,
    target: entry.target,
    changes,
    sourceIp: entry.sourceIp ?? null,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function writeRecoveryNote(root: string, targets: string[]): void {
  writeJsonWithBackupAtomic(resolve(root, 'data', 'config-recovery.json'), {
    timestamp: new Date().toISOString(),
    message: 'Each replaced file has a sibling .bak containing its previous contents.',
    targets,
  });
}
