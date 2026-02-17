/**
 * Deterministic local text embedding helper.
 *
 * This is intentionally provider-agnostic so we can reuse the same
 * embedding payload for pgvector now and Qdrant later.
 */

const TOKEN_REGEX = /[a-z0-9']+/g;

function hashToken(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const raw = lower.match(TOKEN_REGEX) ?? [];
  return raw.filter((token) => token.length >= 2);
}

function normalize(values: number[]): number[] {
  let sumSquares = 0;
  for (const value of values) sumSquares += value * value;
  if (sumSquares === 0) return values;

  const magnitude = Math.sqrt(sumSquares);
  return values.map((value) => value / magnitude);
}

export function embedTextDeterministic(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);

  if (tokens.length === 0) {
    const fallbackHash = hashToken(text);
    const idx = fallbackHash % dimensions;
    vector[idx] = 1;
    return vector;
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const hash = hashToken(token);
    const idx = hash % dimensions;
    const sign = (hash & 1) === 0 ? 1 : -1;
    const tokenWeight = 1 + Math.min(token.length, 12) / 12;
    vector[idx] += sign * tokenWeight;

    if (i < tokens.length - 1) {
      const bigram = `${token}_${tokens[i + 1]}`;
      const bigramHash = hashToken(bigram);
      const bigramIdx = bigramHash % dimensions;
      const bigramSign = (bigramHash & 1) === 0 ? 1 : -1;
      vector[bigramIdx] += bigramSign * 0.5;
    }
  }

  return normalize(vector);
}

export function toPgvectorLiteral(values: number[]): string {
  const rounded = values.map((value) => Number(value.toFixed(6)));
  return `[${rounded.join(',')}]`;
}
