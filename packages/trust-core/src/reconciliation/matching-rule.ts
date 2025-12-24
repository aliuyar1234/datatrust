/**
 * Matching Rule Evaluator
 *
 * Evaluates matching rules against record pairs.
 */

import type { MatchingRule, RuleOperator } from '../types/index.js';
import { TrustError } from '../errors/index.js';
import {
  calculateSimilarity,
  colognePhoneticSimilarity,
  soundexSimilarity,
} from '@datatrust/entity-resolution/similarity';

/**
 * Result of evaluating a single rule
 */
export interface RuleEvaluationResult {
  ruleName: string;
  matched: boolean;
  weight: number;
  required: boolean;
}

/**
 * Evaluates matching rules against record values.
 */
export class MatchingRuleEvaluator {
  /**
   * Evaluate a rule against source and target values.
   */
  evaluate(
    rule: MatchingRule,
    sourceRecord: Record<string, unknown>,
    targetRecord: Record<string, unknown>
  ): RuleEvaluationResult {
    const sourceValue = sourceRecord[rule.sourceField];
    const targetValue = targetRecord[rule.targetField];

    const matched = this.evaluateOperator(
      rule.operator,
      sourceValue,
      targetValue,
      rule.options
    );

    return {
      ruleName: rule.name,
      matched,
      weight: rule.weight,
      required: rule.required ?? false,
    };
  }

  /**
   * Evaluate all rules against a record pair.
   */
  evaluateAll(
    rules: MatchingRule[],
    sourceRecord: Record<string, unknown>,
    targetRecord: Record<string, unknown>
  ): RuleEvaluationResult[] {
    return rules.map((rule) => this.evaluate(rule, sourceRecord, targetRecord));
  }

  /**
   * Check if all required rules matched.
   */
  allRequiredMatched(results: RuleEvaluationResult[]): boolean {
    return results
      .filter((r) => r.required)
      .every((r) => r.matched);
  }

  /**
   * Evaluate a specific operator.
   */
  private evaluateOperator(
    operator: RuleOperator,
    sourceValue: unknown,
    targetValue: unknown,
    options?: MatchingRule['options']
  ): boolean {
    // Handle null/undefined
    if (sourceValue == null || targetValue == null) {
      return false;
    }

    switch (operator) {
      case 'equals':
        return this.evaluateEquals(sourceValue, targetValue, options);

      case 'equals_tolerance':
        return this.evaluateEqualsTolerance(sourceValue, targetValue, options);

      case 'contains':
        return this.evaluateContains(sourceValue, targetValue, options);

      case 'regex':
        return this.evaluateRegex(sourceValue, targetValue, options);

      case 'similarity':
        return this.evaluateSimilarity(sourceValue, targetValue, options);

      case 'date_range':
        return this.evaluateDateRange(sourceValue, targetValue, options);       

      default:
        throw new TrustError({
          code: 'INVALID_RULE',
          message: `Unknown operator: ${operator}`,
        });
    }
  }

  /**
   * Exact equality comparison.
   */
  private evaluateEquals(
    sourceValue: unknown,
    targetValue: unknown,
    options?: MatchingRule['options']
  ): boolean {
    const caseSensitive = options?.caseSensitive ?? true;

    if (typeof sourceValue === 'string' && typeof targetValue === 'string') {
      if (caseSensitive) {
        return sourceValue === targetValue;
      }
      return sourceValue.toLowerCase() === targetValue.toLowerCase();
    }

    return sourceValue === targetValue;
  }

  /**
   * Numeric equality with tolerance.
   */
  private evaluateEqualsTolerance(
    sourceValue: unknown,
    targetValue: unknown,
    options?: MatchingRule['options']
  ): boolean {
    const tolerance = options?.tolerance ?? 0;

    const sourceNum = this.toNumber(sourceValue);
    const targetNum = this.toNumber(targetValue);

    if (sourceNum === null || targetNum === null) {
      return false;
    }

    return Math.abs(sourceNum - targetNum) <= tolerance;
  }

  /**
   * String contains check.
   */
  private evaluateContains(
    sourceValue: unknown,
    targetValue: unknown,
    options?: MatchingRule['options']
  ): boolean {
    const caseSensitive = options?.caseSensitive ?? false;

    let sourceStr = String(sourceValue);
    let targetStr = String(targetValue);

    if (!caseSensitive) {
      sourceStr = sourceStr.toLowerCase();
      targetStr = targetStr.toLowerCase();
    }

    // Check if source contains target OR target contains source
    return sourceStr.includes(targetStr) || targetStr.includes(sourceStr);
  }

  /**
   * Regex pattern match.
   */
  private evaluateRegex(
    sourceValue: unknown,
    targetValue: unknown,
    options?: MatchingRule['options']
  ): boolean {
    const sourceStr = String(sourceValue);
    const targetStr = String(targetValue);

    const caseSensitive = options?.caseSensitive ?? false;
    const unsafeRegex = options?.unsafeRegex ?? false;

    // Default to a safe literal contains check to avoid ReDoS on untrusted patterns.
    if (!unsafeRegex) {
      if (caseSensitive) {
        return sourceStr.includes(targetStr);
      }
      return sourceStr.toLowerCase().includes(targetStr.toLowerCase());
    }

    // Guardrails for unsafe regex mode.
    if (targetStr.length > 200 || sourceStr.length > 10_000) {
      return false;
    }

    try {
      const flags = caseSensitive ? '' : 'i';
      const pattern = new RegExp(targetStr, flags);
      return pattern.test(sourceStr);
    } catch {
      return false;
    }
  }

  /**
   * Fuzzy similarity match.
   *
   * Uses safe, deterministic algorithms (no regex backtracking). Intended for
   * human-entered fields like names, references, and free text.
   */
  private evaluateSimilarity(
    sourceValue: unknown,
    targetValue: unknown,
    options?: MatchingRule['options']
  ): boolean {
    const threshold = options?.similarityThreshold ?? 0.85;
    if (threshold < 0 || threshold > 1) {
      throw new TrustError({
        code: 'INVALID_RULE',
        message: `similarityThreshold must be between 0 and 1 (got ${threshold})`,
      });
    }

    const algorithm = options?.similarityAlgorithm ?? 'jaro_winkler';
    const caseSensitive = options?.caseSensitive ?? false;

    let sourceStr = String(sourceValue);
    let targetStr = String(targetValue);

    if (!caseSensitive) {
      sourceStr = sourceStr.toLowerCase();
      targetStr = targetStr.toLowerCase();
    }

    if (sourceStr.length > 10_000 || targetStr.length > 10_000) {
      return false;
    }

    let score: number;
    if (algorithm === 'cologne_phonetic') {
      score = colognePhoneticSimilarity(sourceStr, targetStr).score;
    } else if (algorithm === 'soundex') {
      score = soundexSimilarity(sourceStr, targetStr).score;
    } else {
      const similarity = calculateSimilarity(sourceStr, targetStr, algorithm, {
        ngramSize: options?.ngramSize,
        prefixScale: options?.prefixScale,
      });
      score = similarity.score;
    }

    return score >= threshold;
  }

  /**
   * Date within range comparison.
   */
  private evaluateDateRange(
    sourceValue: unknown,
    targetValue: unknown,
    options?: MatchingRule['options']
  ): boolean {
    const rangeDays = options?.dateRangeDays ?? 0;

    const sourceDate = this.toDate(sourceValue);
    const targetDate = this.toDate(targetValue);

    if (!sourceDate || !targetDate) {
      return false;
    }

    const diffMs = Math.abs(sourceDate.getTime() - targetDate.getTime());
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    return diffDays <= rangeDays;
  }

  /**
   * Convert value to number.
   */
  private toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return isNaN(value) ? null : value;
    }
    if (typeof value === 'string') {
      // Handle currency strings like "1.234,56" or "1,234.56"
      const normalized = value
        .replace(/[^\d.,+-]/g, '')
        .replace(/\.(?=.*\.)/g, '')
        .replace(',', '.');
      const num = parseFloat(normalized);
      return isNaN(num) ? null : num;
    }
    return null;
  }

  /**
   * Convert value to Date.
   */
  private toDate(value: unknown): Date | null {
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date;
    }
    return null;
  }
}
