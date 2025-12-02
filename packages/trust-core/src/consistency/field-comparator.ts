/**
 * FieldComparator
 *
 * Compares individual field values with support for custom comparators.
 */

import type { Record as DataRecord } from '@datatrust/core';
import type { FieldDifference, FieldMapping, MappingConfig, FieldTransform } from '../types/index.js';

/** Custom comparator function type */
export type ComparatorFn = (sourceValue: unknown, targetValue: unknown) => boolean;

/** Built-in comparators */
const BUILT_IN_COMPARATORS: Record<string, ComparatorFn> = {
  exact: (a, b) => a === b,
  caseInsensitive: (a, b) =>
    String(a).toLowerCase() === String(b).toLowerCase(),
  numericTolerance: (a, b) =>
    Math.abs(Number(a) - Number(b)) < 0.001,
  dateOnly: (a, b) => {
    const dateA = new Date(String(a)).toISOString().split('T')[0];
    const dateB = new Date(String(b)).toISOString().split('T')[0];
    return dateA === dateB;
  },
  trimmedString: (a, b) =>
    String(a).trim() === String(b).trim(),
};

export class FieldComparator {
  private customComparators: Map<string, ComparatorFn> = new Map();

  /**
   * Register a custom comparator
   */
  registerComparator(name: string, fn: ComparatorFn): void {
    this.customComparators.set(name, fn);
  }

  /**
   * Compare two records and return field-level differences
   */
  compareRecords(
    sourceRecord: DataRecord,
    targetRecord: DataRecord,
    mapping: MappingConfig
  ): FieldDifference[] {
    const differences: FieldDifference[] = [];

    for (const fieldMapping of mapping.fields) {
      const diff = this.compareField(sourceRecord, targetRecord, fieldMapping);
      if (diff) {
        differences.push(diff);
      }
    }

    return differences;
  }

  /**
   * Compare a single field between source and target
   */
  private compareField(
    sourceRecord: DataRecord,
    targetRecord: DataRecord,
    fieldMapping: FieldMapping
  ): FieldDifference | null {
    const sourceValue = sourceRecord[fieldMapping.source];
    const targetValue = targetRecord[fieldMapping.target];

    // Handle missing values
    const sourceHasValue = sourceValue !== undefined && sourceValue !== null;
    const targetHasValue = targetValue !== undefined && targetValue !== null;

    if (!sourceHasValue && !targetHasValue) {
      return null; // Both missing = match
    }

    if (!sourceHasValue) {
      return {
        field: fieldMapping.source,
        sourceValue,
        targetValue,
        type: 'missing_in_source',
      };
    }

    if (!targetHasValue) {
      return {
        field: fieldMapping.source,
        sourceValue,
        targetValue,
        type: 'missing_in_target',
      };
    }

    // Apply transformation if specified
    const transformedSource = fieldMapping.transform
      ? this.applyTransform(sourceValue, fieldMapping.transform)
      : sourceValue;

    // Get comparator
    const comparator = this.getComparator(fieldMapping.comparator);

    // Compare values
    if (!comparator(transformedSource, targetValue)) {
      const sourceType = typeof transformedSource;
      const targetType = typeof targetValue;

      return {
        field: fieldMapping.source,
        sourceValue,
        targetValue,
        type: sourceType !== targetType ? 'type_mismatch' : 'value_mismatch',
      };
    }

    return null; // Values match
  }

  /**
   * Get comparator function by name
   */
  private getComparator(name?: string): ComparatorFn {
    if (!name) {
      return BUILT_IN_COMPARATORS['exact']!;
    }

    const custom = this.customComparators.get(name);
    if (custom) {
      return custom;
    }

    const builtin = BUILT_IN_COMPARATORS[name];
    if (builtin) {
      return builtin;
    }

    return BUILT_IN_COMPARATORS['exact']!;
  }

  /**
   * Apply field transformation
   */
  private applyTransform(value: unknown, transform: FieldTransform): unknown {
    switch (transform) {
      case 'lowercase':
        return String(value).toLowerCase();
      case 'uppercase':
        return String(value).toUpperCase();
      case 'trim':
        return String(value).trim();
      case 'normalizeWhitespace':
        return String(value).replace(/\s+/g, ' ').trim();
      case 'parseDate':
        return new Date(String(value));
      case 'parseNumber':
        return Number(value);
      case 'toString':
        return String(value);
      default:
        return value;
    }
  }
}
