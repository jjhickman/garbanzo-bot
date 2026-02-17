import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const dockerfilePath = resolve(process.cwd(), 'Dockerfile');

describe('Docker runtime assets', () => {
  it('includes postgres schema SQL in runtime image', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf-8');
    expect(dockerfile).toContain('/app/src/utils/postgres-schema.sql');
    expect(dockerfile).toContain('./src/utils/postgres-schema.sql');
  });

  it('includes platform persona docs in runtime image', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf-8');
    expect(dockerfile).toContain('docs/personas/');
    expect(dockerfile).toContain('./docs/personas/');
  });
});
