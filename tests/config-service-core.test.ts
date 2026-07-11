import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appendConfigAudit } from '../src/cli/config-service/audit.js';
import {
  applyStagedBundle,
  buildExportBundle,
  IMPORT_LIMITS,
  validateBundleLimits,
} from '../src/cli/config-service/bundle.js';
import { runWizard } from '../src/cli/config-service/wizard.js';

describe('config service core operations', () => {
  const roots: string[] = [];
  const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'garbanzo-config-core-'));
    roots.push(root);
    return root;
  };

  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it('exports only secret-masked config content and audits secret changes safely', () => {
    const root = tempRoot();
    const canary = 'config_export_canary_4d77';
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, '.env'), `MESSAGING_PLATFORM=discord\nOPENAI_API_KEY=${canary}\n`);
    writeFileSync(join(root, 'config', 'rag-sources.json'), JSON.stringify({ sources: [{
      id: 'one', label: 'One', apiKey: canary, collection: 'facts', embedding: { provider: 'openai' },
    }] }));
    appendConfigAudit(root, {
      action: 'test', target: 'env', changes: [{ key: 'OPENAI_API_KEY', before: 'old', after: canary }],
    });

    expect(JSON.stringify(buildExportBundle(root))).not.toContain(canary);
    expect(readFileSync(join(root, 'data', 'config-audit.jsonl'), 'utf8')).not.toContain(canary);
  });

  it('enforces unsafe-path, expanded-size, file-count, depth, and ratio limits', () => {
    expect(validateBundleLimits({ format: 'garbanzo-config-bundle-v1', files: { '../escape': 'x' } }, 100)).toBe('unsafe-path');
    expect(validateBundleLimits({ format: 'garbanzo-config-bundle-v1', files: { 'a/b/c/d/e/f': 'x' } }, 100)).toBe('unsafe-path');
    expect(validateBundleLimits({
      format: 'garbanzo-config-bundle-v1',
      files: Object.fromEntries(Array.from({ length: IMPORT_LIMITS.files + 1 }, (_, index) => [`f${index}`, 'x'])),
    }, 1_000)).toBe('file-count-limit');
    expect(validateBundleLimits({
      format: 'garbanzo-config-bundle-v1', files: { '.env': 'x'.repeat(101) },
    }, 1)).toBe('expansion-ratio-limit');
    expect(validateBundleLimits({ format: 'garbanzo-config-bundle-v1', files: {} }, IMPORT_LIMITS.compressedBytes + 1)).toBe('compressed-size-limit');
  });

  it('keeps service wizard output byte-identical to the shared CLI runner', { timeout: 30_000 }, async () => {
    const cliRoot = tempRoot();
    const serviceRoot = tempRoot();
    const args = [
      '--platform=whatsapp', '--deploy=native', '--providers=openrouter', '--provider-order=openrouter',
      '--openrouter-key=test_key_ci', '--owner-jid=test_owner@s.whatsapp.net', '--write-groups=false',
    ];
    expect((await runWizard(cliRoot, { args })).code).toBe(0);
    applyStagedBundle(serviceRoot, cliRoot);

    const files = (root: string): string[] => readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
      .sort();
    expect(files(serviceRoot)).toEqual(files(cliRoot));
    for (const path of files(cliRoot)) {
      expect(readFileSync(join(serviceRoot, path))).toEqual(readFileSync(join(cliRoot, path)));
    }
  });
});
