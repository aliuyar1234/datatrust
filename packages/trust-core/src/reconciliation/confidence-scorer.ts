/**
 * Confidence Scorer
 *
 * Calculates confidence scores for record matches based on rule results.
 */

import type { RuleEvaluationResult } from './matching-rule.js';

/**
 * Calculates confidence scores based on weighted rule results.
 */
export class ConfidenceScorer {
  /**
   * Calculate confidence score from rule evaluation results.
   *
   * Score is calculated as:
   * - Sum of weights for matched rules / Total weight of all rules * 100
   *
   * @param results - Rule evaluation results
   * @returns Confidence score (0-100)
   */
  calculate(results: RuleEvaluationResult[]): number {
    if (results.length === 0) {
      return 0;
    }

    const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
    if (totalWeight === 0) {
      return 0;
    }

    const matchedWeight = results
      .filter((r) => r.matched)
      .reduce((sum, r) => sum + r.weight, 0);

    const score = (matchedWeight / totalWeight) * 100;
    return Math.round(score * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Calculate average confidence for a set of matches.
   */
  calculateAverage(confidences: number[]): number {
    if (confidences.length === 0) {
      return 0;
    }

    const sum = confidences.reduce((a, b) => a + b, 0);
    const avg = sum / confidences.length;
    return Math.round(avg * 100) / 100;
  }

  /**
   * Check if confidence meets minimum threshold.
   */
  meetsThreshold(confidence: number, minConfidence: number): boolean {
    return confidence >= minConfidence;
  }
}
