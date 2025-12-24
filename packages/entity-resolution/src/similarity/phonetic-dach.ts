/**
 * Phonetic Matching for DACH Region
 *
 * Implements Cologne Phonetics (Kölner Phonetik) for German names.
 * This is superior to Soundex for German language.
 *
 * Examples:
 * - "Müller", "Mueller", "Muller" → all produce same code
 * - "Meier", "Meyer", "Maier", "Mayer", "Mayr" → all produce "67"
 * - "Schmidt", "Schmitt", "Schmid" → similar codes
 */

import { colognePhonetic } from 'cologne-phonetic';
import type { SimilarityResult } from '../types/similarity.js';

/**
 * Generate Cologne phonetic code for a string
 *
 * The Cologne phonetic produces a numeric code where similar-sounding
 * German words produce the same or similar codes.
 */
export function getCologneCode(text: string): string {
  // Normalize umlauts before phonetic encoding
  const normalized = normalizeGermanText(text);
  return colognePhonetic(normalized);
}

/**
 * Compare two strings using Cologne phonetics
 *
 * @returns Similarity based on phonetic codes
 */
export function colognePhoneticSimilarity(a: string, b: string): SimilarityResult {
  const codeA = getCologneCode(a);
  const codeB = getCologneCode(b);

  if (codeA === codeB) {
    return {
      score: 1,
      algorithm: 'cologne_phonetic',
      details: `Both encode to: ${codeA}`,
    };
  }

  // Calculate similarity between phonetic codes
  // Use character-level comparison for partial matches
  const maxLen = Math.max(codeA.length, codeB.length);
  if (maxLen === 0) {
    return { score: 0, algorithm: 'cologne_phonetic' };
  }

  let matches = 0;
  const minLen = Math.min(codeA.length, codeB.length);

  for (let i = 0; i < minLen; i++) {
    if (codeA[i] === codeB[i]) {
      matches++;
    }
  }

  // Weight prefix matches more heavily (first characters matter more)
  let prefixMatch = 0;
  for (let i = 0; i < minLen; i++) {
    if (codeA[i] === codeB[i]) {
      prefixMatch++;
    } else {
      break;
    }
  }

  // Score: 60% position-based matches, 40% prefix bonus
  const positionScore = matches / maxLen;
  const prefixScore = prefixMatch / maxLen;
  const score = positionScore * 0.6 + prefixScore * 0.4;

  return {
    score,
    algorithm: 'cologne_phonetic',
    details: `"${a}" → ${codeA}, "${b}" → ${codeB}`,
  };
}

/**
 * Normalize German text for phonetic matching
 *
 * Handles:
 * - Umlauts: ä→a, ö→o, ü→u
 * - Sharp S: ß→ss
 * - Common variations: ae→ä (but we normalize to base)
 */
export function normalizeGermanText(text: string): string {
  return text
    .toLowerCase()
    // Expand umlauts
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    // Remove diacritics from other characters
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize umlauts bidirectionally
 *
 * Converts both directions to a canonical form:
 * - "Mueller" and "Müller" both become "muller"
 */
export function normalizeUmlauts(text: string): string {
  return text
    .toLowerCase()
    // Convert written-out umlauts to base vowels
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    // Convert actual umlauts to base vowels
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss');
}

/**
 * Check if two strings match phonetically
 *
 * Returns true if they have the same Cologne phonetic code
 */
export function phoneticMatch(a: string, b: string): boolean {
  return getCologneCode(a) === getCologneCode(b);
}

/**
 * Generate phonetic variants of a name
 *
 * Useful for blocking: generate all phonetically similar forms
 */
export function getPhoneticVariants(name: string): string[] {
  const variants: Set<string> = new Set();
  const normalized = name.toLowerCase();

  // Original
  variants.add(normalized);

  // With umlauts expanded
  variants.add(
    normalized
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
  );

  // With umlauts contracted (ae→ä)
  variants.add(
    normalized
      .replace(/ae/g, 'ä')
      .replace(/oe/g, 'ö')
      .replace(/ue/g, 'ü')
  );

  // Common German name variations
  if (normalized.includes('schmidt')) {
    variants.add(normalized.replace('schmidt', 'schmitt'));
    variants.add(normalized.replace('schmidt', 'schmid'));
  }
  if (normalized.includes('meier')) {
    variants.add(normalized.replace('meier', 'meyer'));
    variants.add(normalized.replace('meier', 'maier'));
    variants.add(normalized.replace('meier', 'mayer'));
  }

  return Array.from(variants);
}

/**
 * Simple Soundex implementation (for fallback/comparison)
 *
 * American Soundex - less suitable for German but included for completeness
 */
export function soundex(text: string): string {
  const normalized = text.toUpperCase().replace(/[^A-Z]/g, '');

  if (normalized.length === 0) {
    return '0000';
  }

  const codes: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6',
  };

  const firstChar = normalized[0];
  if (!firstChar) {
    return '0000';
  }

  let result = firstChar;
  let prevCode = codes[firstChar] ?? '';

  for (let i = 1; i < normalized.length && result.length < 4; i++) {      
    const char = normalized[i];
    if (!char) break;
    const code = codes[char];

    if (code && code !== prevCode) {
      result += code;
      prevCode = code;
    } else if (!code) {
      prevCode = '';
    }
  }

  return result.padEnd(4, '0');
}

/**
 * Compare using Soundex
 */
export function soundexSimilarity(a: string, b: string): SimilarityResult {
  const codeA = soundex(a);
  const codeB = soundex(b);

  if (codeA === codeB) {
    return {
      score: 1,
      algorithm: 'soundex',
      details: `Both encode to: ${codeA}`,
    };
  }

  // Partial match based on code similarity
  let matches = 0;
  for (let i = 0; i < 4; i++) {
    if (codeA[i] === codeB[i]) {
      matches++;
    }
  }

  return {
    score: matches / 4,
    algorithm: 'soundex',
    details: `"${a}" → ${codeA}, "${b}" → ${codeB}`,
  };
}
