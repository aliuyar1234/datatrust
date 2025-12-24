/**
 * Blocking strategies (candidate generation).
 *
 * Placeholder entrypoint so package exports remain stable even before blocking
 * implementations are added.
 */

import { getCologneCode, soundex } from '../similarity/phonetic-dach.js';

export type BlockingAlgorithm =
  | 'exact'
  | 'prefix'
  | 'cologne_phonetic'
  | 'soundex';

export type BlockingKeyOptions = {
  caseSensitive?: boolean;
  prefixLength?: number;
  maxLength?: number;
};

function normalizeText(text: string, caseSensitive: boolean): string {
  const trimmed = text.replace(/\\s+/g, ' ').trim();
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

export function createBlockingKey(
  value: unknown,
  algorithm: BlockingAlgorithm,
  options?: BlockingKeyOptions
): string | null {
  if (value === null || value === undefined) return null;
  const caseSensitive = options?.caseSensitive ?? false;

  let base: string;
  if (typeof value === 'string') {
    base = normalizeText(value, caseSensitive);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    base = String(value);
  } else if (value instanceof Date) {
    base = value.toISOString();
  } else {
    try {
      base = JSON.stringify(value);
    } catch {
      base = String(value);
    }
  }

  if (base.length === 0) return null;

  const maxLength = options?.maxLength;
  if (maxLength && maxLength > 0 && base.length > maxLength) {
    base = base.slice(0, maxLength);
  }

  if (algorithm === 'exact') return base;
  if (algorithm === 'prefix') {
    const n = options?.prefixLength ?? 4;
    return base.slice(0, Math.max(1, n));
  }
  if (algorithm === 'cologne_phonetic') return getCologneCode(base);
  if (algorithm === 'soundex') return soundex(base);

  return base;
}
