import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const composeFiles = [
  'docker-compose.yml',
  'docker-compose.prod.yml',
];

describe('qdrant compose service', () => {
  for (const file of composeFiles) {
    it(`${file} defines a qdrant service with a persistent volume`, () => {
      const text = readFileSync(file, 'utf-8');
      expect(text).toMatch(/qdrant:/);
      expect(text).toMatch(/qdrant\/qdrant/);
      expect(text).toMatch(/\/qdrant\/storage/);
    });
  }
});
