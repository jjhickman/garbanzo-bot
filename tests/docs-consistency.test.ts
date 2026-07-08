import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type DocFile = {
  path: string;
  text: string;
};

export const BANNED_GROUP_CHAT_PATTERN = /(?<!\bWhatsApp\s)group chats?/i;

export const BANNED_STALE_DOC_PATTERNS = [
  /APP_VERSION=0\.2/,
  /logs -f garbanzo\b/,
  /docker-compose\.remy\.yml/,
  /VECTOR_DB_PLAN|VECTOR_MEMORY_IMPLEMENTATION_SPEC|MULTI_PLATFORM\.md|PROMOTION_SNIPPETS/,
  /--profile monitoring up/,
  /\bdefault\b.*http:\/\/qdrant:6333/i,
  /npx garbanzo\b(?!-bot)/,
  /Docker (?:and Docker Compose )?(?:is|are) required/i,
  /self-hosted/i,
  BANNED_GROUP_CHAT_PATTERN,
  /uptime kuma|\bKuma\b/i,
  // Regression guard (T3, v3.3.0): Telegram shipped as a fully supported
  // platform — "Telegram (in development)"-style claims (Telegram named as
  // the direct subject of "in development", not merely co-mentioned near a
  // still-in-development platform like Matrix) must not creep back in.
  /Telegram\s*(?:<em>)?\s*(?:is\s+|are\s+)?in development/i,
  // Regression guard (T10, v3.3.0): Matrix also shipped as a fully supported
  // platform (a T1-era "in development" claim lingered on the website until
  // this task) — "Matrix (in development)"-style claims must not creep back.
  /Matrix\s*(?:<em>)?\s*(?:is\s+|are\s+)?in development/i,
] as const;

const PORT_REGRESSION_DOC_PATHS = [
  'docs/SETUP_EXAMPLES.md',
  'docs/BAND_FEATURES.md',
  'deploy/helm/garbanzo/templates/NOTES.txt',
] as const;

const BANNED_BARE_HEALTH_PORT_PATTERNS = [
  /http:\/\/(?:127\.0\.0\.1|localhost):300[1-5]\b/i,
  /\b(?:discord|whatsapp|telegram|matrix):300[1-5]\b/i,
  /\bhealth port 300[1-5]\b/i,
  /\bhealthPort=300[1-5]\b/,
  /\bset healthPort=300[1-5]\b/i,
  /\b300[1-5]\/tcp\b/i,
] as const;

const repoRoot = process.cwd();
const docsRoot = resolve(repoRoot, 'docs');

function walkMarkdownFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (normalize(fullPath).startsWith(resolve(docsRoot, '_internal'))) continue;
      files.push(...walkMarkdownFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
  }

  return files;
}

function readDocsForStalePatternScan(): DocFile[] {
  const paths = [
    resolve(repoRoot, 'README.md'),
    resolve(repoRoot, 'CHANGELOG.md'),
    ...walkMarkdownFiles(docsRoot),
  ];

  return paths.map((path) => ({
    path,
    text: readFileSync(path, 'utf-8'),
  }));
}

function readTopLevelDocsForLinkScan(): DocFile[] {
  const paths = [
    resolve(repoRoot, 'README.md'),
    ...readdirSync(docsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => resolve(docsRoot, entry.name)),
  ];

  return paths.map((path) => ({
    path,
    text: readFileSync(path, 'utf-8'),
  }));
}

function displayPath(path: string): string {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function stripTargetDecorators(target: string): string {
  return target
    .replace(/^<|>$/g, '')
    .split('#')[0]
    ?.split('?')[0] ?? '';
}

function resolvesToExistingFile(fromFile: string, target: string): boolean {
  const cleanTarget = stripTargetDecorators(target);
  if (!cleanTarget) return true;
  const absoluteTarget = cleanTarget.startsWith('/')
    ? cleanTarget
    : cleanTarget.startsWith('docs/')
      ? resolve(repoRoot, cleanTarget)
    : resolve(dirname(fromFile), cleanTarget);

  return existsSync(absoluteTarget) && statSync(absoluteTarget).isFile();
}

function markdownLinks(text: string): string[] {
  return Array.from(text.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
    .map((match) => match[1])
    .filter((target): target is string => typeof target === 'string');
}

function markdownImages(text: string): string[] {
  const markdownTargets = Array.from(text.matchAll(/!\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
    .map((match) => match[1])
    .filter((target): target is string => typeof target === 'string');
  const htmlTargets = Array.from(text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi))
    .map((match) => match[1])
    .filter((target): target is string => typeof target === 'string');

  return [...markdownTargets, ...htmlTargets];
}

function isScopedRelativeDocLink(target: string): boolean {
  const cleanTarget = target.replace(/^<|>$/g, '');
  // Any non-URL, non-anchor target is treated as repo-relative so bare paths
  // like deploy/helm/README.md or scripts/garbanzo.service are checked too.
  return !/^(?:https?:|mailto:|#)/i.test(cleanTarget);
}

function isLocalImageTarget(target: string): boolean {
  return !/^(?:https?:|data:|mailto:)/i.test(target);
}

describe('docs consistency', () => {
  it('does not contain known stale operational patterns', () => {
    const failures: string[] = [];

    for (const doc of readDocsForStalePatternScan()) {
      const lines = doc.text.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        for (const pattern of BANNED_STALE_DOC_PATTERNS) {
          if (pattern.test(line)) {
            failures.push(`${displayPath(doc.path)}:${index + 1} matches ${pattern}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('flags generic group chat copy without blocking WhatsApp-qualified wording', () => {
    expect(BANNED_GROUP_CHAT_PATTERN.test('community operations for group chats')).toBe(true);
    expect(BANNED_GROUP_CHAT_PATTERN.test('WhatsApp group chat')).toBe(false);
    expect(BANNED_GROUP_CHAT_PATTERN.test('WhatsApp group')).toBe(false);
  });

  it('keeps operator health ports expressed through platform placeholders', () => {
    const failures: string[] = [];

    for (const relativePath of PORT_REGRESSION_DOC_PATHS) {
      const path = resolve(repoRoot, relativePath);
      const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        for (const pattern of BANNED_BARE_HEALTH_PORT_PATTERNS) {
          if (pattern.test(line)) {
            failures.push(`${relativePath}:${index + 1} matches ${pattern}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps the Docker Hub release description off rejected framing', () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/release-docker.yml'), 'utf-8');

    expect(workflow).not.toMatch(/self-hosted/i);
  });

  it('resolves scoped relative markdown links in README and top-level docs', () => {
    const failures: string[] = [];

    for (const doc of readTopLevelDocsForLinkScan()) {
      for (const target of markdownLinks(doc.text)) {
        if (!isScopedRelativeDocLink(target)) continue;
        if (!resolvesToExistingFile(doc.path, target)) {
          failures.push(`${displayPath(doc.path)} -> ${target}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('resolves README image references', () => {
    const readmePath = resolve(repoRoot, 'README.md');
    const readme = readFileSync(readmePath, 'utf-8');
    const failures = markdownImages(readme)
      .filter(isLocalImageTarget)
      .filter((target) => !resolvesToExistingFile(readmePath, target))
      .map((target) => `README.md -> ${target}`);

    expect(failures).toEqual([]);
  });
});
