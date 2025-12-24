/**
 * Reconciliation Engine
 *
 * Matches and reconciles records between two data sources.
 */

import { randomUUID } from 'crypto';
import type { IConnector, Record as DataRecord } from '@datatrust/core';
import { createBlockingKey } from '@datatrust/entity-resolution/blocking';
import type { IReconciliationEngine } from '../interfaces/index.js';
import type {
  ReconciliationReport,
  ReconciliationOptions,
  MatchResult,
  UnmatchedRecord,
  ReconciliationSummary,
  ConnectorInfo,
} from '../types/index.js';
import { TrustError } from '../errors/index.js';
import { MatchingRuleEvaluator } from './matching-rule.js';
import { ConfidenceScorer } from './confidence-scorer.js';

/**
 * Reconciliation Engine Implementation
 *
 * Matches records between source and target connectors using
 * configurable rules and confidence scoring.
 */
export class ReconciliationEngine implements IReconciliationEngine {
  private readonly ruleEvaluator: MatchingRuleEvaluator;
  private readonly scorer: ConfidenceScorer;

  constructor() {
    this.ruleEvaluator = new MatchingRuleEvaluator();
    this.scorer = new ConfidenceScorer();
  }

  /**
   * Reconcile records between source and target connectors.
   */
  async reconcile(
    source: IConnector,
    target: IConnector,
    options: ReconciliationOptions
  ): Promise<ReconciliationReport> {
    const startTime = Date.now();

    // Validate connectors
    this.validateConnectors(source, target);

    // Validate options
    this.validateOptions(options);

    // Extract options with defaults
    const {
      rules,
      sourceKeyField = 'id',
      targetKeyField = 'id',
      minConfidence = 50,
      maxRecords,
      blocking,
    } = options;

    // Load records
    const sourceResult = await source.readRecords({ limit: maxRecords });
    const targetResult = await target.readRecords({ limit: maxRecords });

    const sourceRecords = sourceResult.records;
    const targetRecords = targetResult.records;

    // Find matches
    const { matched, unmatchedSource, unmatchedTarget } = this.findMatches(
      sourceRecords,
      targetRecords,
      rules,
      sourceKeyField,
      targetKeyField,
      minConfidence,
      blocking
    );

    // Calculate summary
    const confidences = matched.map((m) => m.confidence);
    const summary: ReconciliationSummary = {
      sourceCount: sourceRecords.length,
      targetCount: targetRecords.length,
      matchedCount: matched.length,
      unmatchedSourceCount: unmatchedSource.length,
      unmatchedTargetCount: unmatchedTarget.length,
      averageConfidence: this.scorer.calculateAverage(confidences),
    };

    // Build connector info
    const sourceInfo: ConnectorInfo = {
      id: source.config.id,
      name: source.config.name || source.config.id,
      type: source.config.type,
    };

    const targetInfo: ConnectorInfo = {
      id: target.config.id,
      name: target.config.name || target.config.id,
      type: target.config.type,
    };

    return {
      id: randomUUID(),
      timestamp: new Date(),
      source: sourceInfo,
      target: targetInfo,
      rules,
      summary,
      matched,
      unmatchedSource,
      unmatchedTarget,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Find matches between source and target records.
   */
  private findMatches(
    sourceRecords: DataRecord[],
    targetRecords: DataRecord[],
    rules: ReconciliationOptions['rules'],
    sourceKeyField: string,
    targetKeyField: string,
    minConfidence: number,
    blocking?: ReconciliationOptions['blocking']
  ): {
    matched: MatchResult[];
    unmatchedSource: UnmatchedRecord[];
    unmatchedTarget: UnmatchedRecord[];
  } {
    const matched: MatchResult[] = [];
    const matchedTargetKeys = new Set<string>();

    const blockingMode = blocking?.mode ?? 'auto';
    const maxKeyLength = 256;
    const separator = '\u001F';

    type BlockingFieldPair = {
      sourceField: string;
      targetField: string;
      caseSensitive: boolean;
    };

    const requiredEqualsRules: BlockingFieldPair[] =
      blockingMode === 'auto'
        ? rules
            .filter((r) => r.required === true && r.operator === 'equals')
            .map((r) => ({
              sourceField: r.sourceField,
              targetField: r.targetField,
              caseSensitive: r.options?.caseSensitive ?? true,
            }))
        : [];

    const canAutoBlock = requiredEqualsRules.length > 0;
    const configuredSourceField =
      blockingMode === 'configured' ? blocking?.sourceField : undefined;
    const configuredTargetField =
      blockingMode === 'configured' ? blocking?.targetField : undefined;
    const configuredAlgorithm = blocking?.algorithm ?? 'exact';
    const configuredPrefixLength = blocking?.prefixLength;

    const buildCompositeKey = (
      record: DataRecord,
      pairs: BlockingFieldPair[],
      side: 'source' | 'target'
    ): string | null => {
      const parts: string[] = [];
      for (const pair of pairs) {
        const field = side === 'source' ? pair.sourceField : pair.targetField;
        const key = createBlockingKey(record[field], 'exact', {
          caseSensitive: pair.caseSensitive,
          maxLength: maxKeyLength,
        });
        if (!key) return null;
        parts.push(key);
      }
      return parts.join(separator);
    };

    const buildConfiguredKey = (
      record: DataRecord,
      field: string
    ): string | null =>
      createBlockingKey(record[field], configuredAlgorithm, {
        caseSensitive: false,
        maxLength: maxKeyLength,
        prefixLength: configuredPrefixLength,
      });

    let targetIndex: Map<string, DataRecord[]> | null = null;
    if (blockingMode === 'auto' && canAutoBlock) {
      targetIndex = new Map<string, DataRecord[]>();
      for (const targetRecord of targetRecords) {
        const key = buildCompositeKey(targetRecord, requiredEqualsRules, 'target');
        if (!key) continue;
        const bucket = targetIndex.get(key);
        if (bucket) bucket.push(targetRecord);
        else targetIndex.set(key, [targetRecord]);
      }
    } else if (
      blockingMode === 'configured' &&
      configuredSourceField &&
      configuredTargetField
    ) {
      targetIndex = new Map<string, DataRecord[]>();
      for (const targetRecord of targetRecords) {
        const key = buildConfiguredKey(targetRecord, configuredTargetField);
        if (!key) continue;
        const bucket = targetIndex.get(key);
        if (bucket) bucket.push(targetRecord);
        else targetIndex.set(key, [targetRecord]);
      }
    }

    const getCandidates = (sourceRecord: DataRecord): DataRecord[] => {
      if (blockingMode === 'off') return targetRecords;

      if (blockingMode === 'auto' && canAutoBlock) {
        const key = buildCompositeKey(sourceRecord, requiredEqualsRules, 'source');
        if (!key) return [];
        return targetIndex?.get(key) ?? [];
      }

      if (
        blockingMode === 'configured' &&
        configuredSourceField &&
        configuredTargetField
      ) {
        const key = buildConfiguredKey(sourceRecord, configuredSourceField);
        if (!key) return targetRecords;
        const candidates = targetIndex?.get(key);
        return candidates && candidates.length > 0 ? candidates : targetRecords;
      }

      return targetRecords;
    };

    // For each source record, find the best matching target
    for (const sourceRecord of sourceRecords) {
      const sourceKey = this.extractKey(sourceRecord, sourceKeyField);
      let bestMatch: { targetRecord: DataRecord; confidence: number; matchedRules: string[]; failedRules: string[] } | null = null;

      const candidates = getCandidates(sourceRecord);
      for (const targetRecord of candidates) {
        const targetKey = this.extractKey(targetRecord, targetKeyField);

        // Skip already matched targets
        if (matchedTargetKeys.has(targetKey)) continue;

        // Evaluate rules
        const results = this.ruleEvaluator.evaluateAll(rules, sourceRecord, targetRecord);

        // Check required rules
        if (!this.ruleEvaluator.allRequiredMatched(results)) continue;

        // Calculate confidence
        const confidence = this.scorer.calculate(results);

        // Check minimum confidence
        if (!this.scorer.meetsThreshold(confidence, minConfidence)) continue;

        // Track best match
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = {
            targetRecord,
            confidence,
            matchedRules: results.filter((r) => r.matched).map((r) => r.ruleName),
            failedRules: results.filter((r) => !r.matched).map((r) => r.ruleName),
          };
        }
      }

      // Record the best match
      if (bestMatch) {
        const targetKey = this.extractKey(bestMatch.targetRecord, targetKeyField);
        matchedTargetKeys.add(targetKey);

        matched.push({
          sourceRecord,
          targetRecord: bestMatch.targetRecord,
          sourceKey,
          targetKey,
          confidence: bestMatch.confidence,
          matchedRules: bestMatch.matchedRules,
          failedRules: bestMatch.failedRules,
        });
      }
    }

    // Find unmatched source records
    const matchedSourceKeys = new Set(matched.map((m) => m.sourceKey));
    const unmatchedSource: UnmatchedRecord[] = sourceRecords
      .filter((r) => !matchedSourceKeys.has(this.extractKey(r, sourceKeyField)))
      .map((r) => ({ record: r, key: this.extractKey(r, sourceKeyField) }));

    // Find unmatched target records
    const unmatchedTarget: UnmatchedRecord[] = targetRecords
      .filter((r) => !matchedTargetKeys.has(this.extractKey(r, targetKeyField)))
      .map((r) => ({ record: r, key: this.extractKey(r, targetKeyField) }));

    return { matched, unmatchedSource, unmatchedTarget };
  }

  /**
   * Extract key value from record.
   */
  private extractKey(record: DataRecord, keyField: string): string {
    const value = record[keyField];
    if (value === undefined || value === null) {
      return 'unknown';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  /**
   * Validate connector states.
   */
  private validateConnectors(source: IConnector, target: IConnector): void {
    if (source.state !== 'connected') {
      throw new TrustError({
        code: 'SOURCE_NOT_CONNECTED',
        message: `Source connector '${source.config.id}' is not connected (state: ${source.state})`,
      });
    }
    if (target.state !== 'connected') {
      throw new TrustError({
        code: 'TARGET_NOT_CONNECTED',
        message: `Target connector '${target.config.id}' is not connected (state: ${target.state})`,
      });
    }
  }

  /**
   * Validate reconciliation options.
   */
  private validateOptions(options: ReconciliationOptions): void {
    if (!options.rules || options.rules.length === 0) {
      throw new TrustError({
        code: 'INVALID_OPTIONS',
        message: 'At least one matching rule is required',
        suggestion: 'Provide rules array with at least one MatchingRule',
      });
    }

    for (const rule of options.rules) {
      if (!rule.name || !rule.sourceField || !rule.targetField || !rule.operator) {
        throw new TrustError({
          code: 'INVALID_RULE',
          message: `Invalid rule: missing required fields`,
          context: { rule },
        });
      }
      if (rule.weight < 1 || rule.weight > 100) {
        throw new TrustError({
          code: 'INVALID_RULE',
          message: `Rule '${rule.name}' has invalid weight: ${rule.weight}. Must be 1-100`,
        });
      }
    }

    if (options.blocking?.mode === 'configured') {
      if (!options.blocking.sourceField || !options.blocking.targetField) {
        throw new TrustError({
          code: 'INVALID_OPTIONS',
          message: 'Blocking mode "configured" requires sourceField and targetField',
          context: { blocking: options.blocking },
        });
      }
      if (options.blocking.algorithm === 'prefix') {
        const n = options.blocking.prefixLength ?? 4;
        if (!Number.isInteger(n) || n < 1 || n > 32) {
          throw new TrustError({
            code: 'INVALID_OPTIONS',
            message: `blocking.prefixLength must be an integer between 1 and 32 (got ${n})`,
            context: { blocking: options.blocking },
          });
        }
      }
    }
  }
}
