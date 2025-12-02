/**
 * RecordMatcher
 *
 * Matches records between source and target using key fields.
 */

import type { Record as DataRecord } from '@datatrust/core';
import type {
  MappingConfig,
  KeyFieldConfig,
  RecordComparison,
  ComparisonSummary,
  FieldDifference,
} from '../types/index.js';
import type { FieldComparator } from './field-comparator.js';

export class RecordMatcher {
  private keyConfig: KeyFieldConfig;

  constructor(mapping: MappingConfig) {
    this.keyConfig = mapping.keyFields ?? { source: 'id', target: 'id' };
  }

  /**
   * Extract the matching key from a record
   */
  extractKey(record: DataRecord, side: 'source' | 'target'): string | Record<string, unknown> {
    const keyFields = side === 'source' ? this.keyConfig.source : this.keyConfig.target;

    if (typeof keyFields === 'string') {
      return String(record[keyFields] ?? '');
    }

    // Composite key
    const key: Record<string, unknown> = {};
    for (const field of keyFields) {
      key[field] = record[field];
    }
    return key;
  }

  /**
   * Create a string key for Map indexing
   */
  private keyToString(key: string | Record<string, unknown>): string {
    if (typeof key === 'string') {
      return key;
    }
    return JSON.stringify(key);
  }

  /**
   * Build an index of records by their key for efficient matching
   */
  buildIndex(records: DataRecord[], side: 'source' | 'target'): Map<string, DataRecord> {
    const index = new Map<string, DataRecord>();

    for (const record of records) {
      const key = this.extractKey(record, side);
      const keyStr = this.keyToString(key);
      index.set(keyStr, record);
    }

    return index;
  }

  /**
   * Match and compare records from source and target
   */
  matchAndCompare(
    sourceRecords: DataRecord[],
    targetRecords: DataRecord[],
    fieldComparator: FieldComparator,
    mapping: MappingConfig
  ): {
    matched: RecordComparison[];
    sourceOnly: DataRecord[];
    targetOnly: DataRecord[];
    summary: Omit<ComparisonSummary, 'processingTimeMs'>;
  } {
    // Build target index
    const targetIndex = this.buildIndex(targetRecords, 'target');
    const matchedTargetKeys = new Set<string>();

    const matched: RecordComparison[] = [];
    const sourceOnly: DataRecord[] = [];
    const differencesByField = new Map<string, number>();

    let matchCount = 0;
    let differenceCount = 0;

    // Compare each source record
    for (const sourceRecord of sourceRecords) {
      const sourceKey = this.extractKey(sourceRecord, 'source');
      const targetKeyStr = this.mapKeyToTarget(sourceRecord);
      const targetRecord = targetIndex.get(targetKeyStr);

      if (targetRecord) {
        matchedTargetKeys.add(targetKeyStr);

        // Compare fields
        const differences = fieldComparator.compareRecords(
          sourceRecord,
          targetRecord,
          mapping
        );

        if (differences.length === 0) {
          matchCount++;
          matched.push({
            key: sourceKey,
            status: 'match',
            sourceRecord,
            targetRecord,
          });
        } else {
          differenceCount++;
          matched.push({
            key: sourceKey,
            status: 'difference',
            differences,
            sourceRecord,
            targetRecord,
          });

          // Track differences by field
          for (const diff of differences) {
            differencesByField.set(
              diff.field,
              (differencesByField.get(diff.field) ?? 0) + 1
            );
          }
        }
      } else {
        sourceOnly.push(sourceRecord);
      }
    }

    // Find target-only records
    const targetOnly: DataRecord[] = [];
    for (const [keyStr, record] of targetIndex) {
      if (!matchedTargetKeys.has(keyStr)) {
        targetOnly.push(record);
      }
    }

    return {
      matched,
      sourceOnly,
      targetOnly,
      summary: {
        sourceRecordCount: sourceRecords.length,
        targetRecordCount: targetRecords.length,
        matchCount,
        differenceCount,
        sourceOnlyCount: sourceOnly.length,
        targetOnlyCount: targetOnly.length,
        differencesByField,
      },
    };
  }

  /**
   * Map source key fields to target key for lookup
   */
  private mapKeyToTarget(sourceRecord: DataRecord): string {
    const sourceKeyFields = typeof this.keyConfig.source === 'string'
      ? [this.keyConfig.source]
      : this.keyConfig.source;
    const targetKeyFields = typeof this.keyConfig.target === 'string'
      ? [this.keyConfig.target]
      : this.keyConfig.target;

    // Single key field
    if (sourceKeyFields.length === 1) {
      return String(sourceRecord[sourceKeyFields[0]!] ?? '');
    }

    // Composite key - build object with target field names
    const targetKey: Record<string, unknown> = {};
    for (let i = 0; i < sourceKeyFields.length; i++) {
      targetKey[targetKeyFields[i]!] = sourceRecord[sourceKeyFields[i]!];
    }
    return JSON.stringify(targetKey);
  }
}
