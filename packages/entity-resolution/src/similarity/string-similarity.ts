/**
 * String Similarity Functions
 *
 * Core algorithms for measuring string similarity.
 * Uses fastest-levenshtein for performance-critical operations.
 */

import { distance as levenshteinDistance } from 'fastest-levenshtein';
import type { SimilarityResult, SimilarityAlgorithm } from '../types/similarity.js';

/**
 * Calculate normalized Levenshtein similarity
 *
 * @param a First string
 * @param b Second string
 * @returns Similarity score 0-1 (1 = identical)
 */
export function levenshtein(a: string, b: string): SimilarityResult {
  if (a === b) {
    return { score: 1, algorithm: 'levenshtein' };
  }

  if (a.length === 0 || b.length === 0) {
    return { score: 0, algorithm: 'levenshtein' };
  }

  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const score = 1 - dist / maxLen;

  return {
    score,
    algorithm: 'levenshtein',
    details: `Distance: ${dist}, Max length: ${maxLen}`,
  };
}

/**
 * Calculate Jaro similarity
 *
 * Based on: number of matching characters and transpositions.
 * Good for short strings like names.
 */
export function jaro(a: string, b: string): SimilarityResult {
  if (a === b) {
    return { score: 1, algorithm: 'jaro' };
  }

  if (a.length === 0 || b.length === 0) {
    return { score: 0, algorithm: 'jaro' };
  }

  const matchWindow = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);

    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) {
    return { score: 0, algorithm: 'jaro' };
  }

  // Count transpositions
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const score =
    (matches / a.length +
      matches / b.length +
      (matches - transpositions / 2) / matches) /
    3;

  return {
    score,
    algorithm: 'jaro',
    details: `Matches: ${matches}, Transpositions: ${transpositions / 2}`,
  };
}

/**
 * Calculate Jaro-Winkler similarity
 *
 * Extension of Jaro that gives more weight to common prefixes.
 * Excellent for names where the beginning matters most.
 *
 * @param a First string
 * @param b Second string
 * @param prefixScale Scaling factor for common prefix (default: 0.1, max: 0.25)
 */
export function jaroWinkler(
  a: string,
  b: string,
  prefixScale = 0.1
): SimilarityResult {
  const jaroResult = jaro(a, b);

  if (jaroResult.score === 1) {
    return { score: 1, algorithm: 'jaro_winkler' };
  }

  // Calculate common prefix length (max 4 characters)
  let prefixLength = 0;
  const maxPrefix = Math.min(4, Math.min(a.length, b.length));

  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  const score =
    jaroResult.score + prefixLength * prefixScale * (1 - jaroResult.score);

  return {
    score,
    algorithm: 'jaro_winkler',
    details: `Jaro: ${jaroResult.score.toFixed(3)}, Common prefix: ${prefixLength}`,
  };
}

/**
 * Calculate Dice-Sørensen coefficient using bigrams
 *
 * Measures overlap between character n-grams.
 * Good for compound words and longer strings.
 */
export function diceSorensen(a: string, b: string, ngramSize = 2): SimilarityResult {
  if (a === b) {
    return { score: 1, algorithm: 'dice_sorensen' };
  }

  const aNgrams = getNgrams(a, ngramSize);
  const bNgrams = getNgrams(b, ngramSize);

  if (aNgrams.size === 0 || bNgrams.size === 0) {
    return { score: 0, algorithm: 'dice_sorensen' };
  }

  let intersection = 0;
  for (const ngram of aNgrams) {
    if (bNgrams.has(ngram)) {
      intersection++;
    }
  }

  const score = (2 * intersection) / (aNgrams.size + bNgrams.size);

  return {
    score,
    algorithm: 'dice_sorensen',
    details: `Intersection: ${intersection}, A ngrams: ${aNgrams.size}, B ngrams: ${bNgrams.size}`,
  };
}

/**
 * Calculate Jaccard similarity coefficient
 *
 * Measures overlap between sets of n-grams.
 */
export function jaccard(a: string, b: string, ngramSize = 2): SimilarityResult {
  if (a === b) {
    return { score: 1, algorithm: 'jaccard' };
  }

  const aNgrams = getNgrams(a, ngramSize);
  const bNgrams = getNgrams(b, ngramSize);

  if (aNgrams.size === 0 || bNgrams.size === 0) {
    return { score: 0, algorithm: 'jaccard' };
  }

  let intersection = 0;
  for (const ngram of aNgrams) {
    if (bNgrams.has(ngram)) {
      intersection++;
    }
  }

  const union = aNgrams.size + bNgrams.size - intersection;
  const score = intersection / union;

  return {
    score,
    algorithm: 'jaccard',
    details: `Intersection: ${intersection}, Union: ${union}`,
  };
}

/**
 * Extract n-grams from a string
 */
function getNgrams(str: string, n: number): Set<string> {
  const ngrams = new Set<string>();

  if (str.length < n) {
    ngrams.add(str);
    return ngrams;
  }

  for (let i = 0; i <= str.length - n; i++) {
    ngrams.add(str.substring(i, i + n));
  }

  return ngrams;
}

/**
 * Calculate similarity using specified algorithm
 */
export function calculateSimilarity(
  a: string,
  b: string,
  algorithm: SimilarityAlgorithm,
  options?: { ngramSize?: number; prefixScale?: number }
): SimilarityResult {
  switch (algorithm) {
    case 'levenshtein':
      return levenshtein(a, b);
    case 'jaro':
      return jaro(a, b);
    case 'jaro_winkler':
      return jaroWinkler(a, b, options?.prefixScale);
    case 'dice_sorensen':
      return diceSorensen(a, b, options?.ngramSize);
    case 'jaccard':
      return jaccard(a, b, options?.ngramSize);
    default:
      throw new Error(`Unknown algorithm: ${algorithm}`);
  }
}

/**
 * Calculate composite similarity using multiple algorithms
 *
 * Combines multiple algorithms with configurable weights.
 */
export function compositeSimilarity(
  a: string,
  b: string,
  algorithms: Array<{ algorithm: SimilarityAlgorithm; weight: number }>
): SimilarityResult {
  if (a === b) {
    return { score: 1, algorithm: 'composite' };
  }

  let totalWeight = 0;
  let weightedSum = 0;
  const details: string[] = [];

  for (const { algorithm, weight } of algorithms) {
    const result = calculateSimilarity(a, b, algorithm);
    weightedSum += result.score * weight;
    totalWeight += weight;
    details.push(`${algorithm}: ${result.score.toFixed(3)}`);
  }

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    score,
    algorithm: 'composite',
    details: details.join(', '),
  };
}
