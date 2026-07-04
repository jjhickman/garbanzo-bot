import { z } from 'zod';

export const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

export const optionalString = z.preprocess(
  (value) => {
    if (typeof value === 'string' && value.trim() === '') return undefined;
    if (typeof value === 'string') return value.trim();
    return value;
  },
  z.string().min(1).optional(),
);

export const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off', ''].includes(normalized)) return false;
  }
  return value;
}, z.boolean());
