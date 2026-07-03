import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const overlayFiles = [
  'docker-compose.dev.yml',
  'docker-compose.prod.yml',
  'docker-compose.aws.yml',
];

describe('qdrant compose service', () => {
  it('docker-compose.yml defines the qdrant service and persistent volume', () => {
    const text = readFileSync('docker-compose.yml', 'utf-8');
    expect(text).toMatch(/^  qdrant:/m);
    expect(text).toMatch(/qdrant\/qdrant/);
    expect(text).toMatch(/\/qdrant\/storage/);
    expect(text).toMatch(/^  qdrant_data:/m);
  });

  for (const file of overlayFiles) {
    it(`${file} references qdrant without redeclaring the service`, () => {
      const text = readFileSync(file, 'utf-8');
      expect(text).toMatch(/depends_on:\n\s+- qdrant/);
      expect(text).not.toMatch(/^  qdrant:/m);
      expect(text).not.toMatch(/image: qdrant\/qdrant/);
    });
  }
});
