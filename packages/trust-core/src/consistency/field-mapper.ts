/**
 * FieldMapper
 *
 * Handles mapping fields between source and target schemas.
 */

import type { Record as DataRecord } from '@datatrust/core';
import type { FieldMapping, FieldTransform, MappingConfig } from '../types/index.js';

export class FieldMapper {
  /**
   * Transform a source record to use target field names
   */
  mapSourceToTarget(record: DataRecord, mapping: MappingConfig): DataRecord {
    const mapped: DataRecord = {};

    for (const fieldMapping of mapping.fields) {
      const sourceValue = record[fieldMapping.source];
      const transformedValue = fieldMapping.transform
        ? this.applyTransform(sourceValue, fieldMapping.transform)
        : sourceValue;
      mapped[fieldMapping.target] = transformedValue;
    }

    // Include unmapped fields if not strict
    if (!mapping.strictMapping) {
      for (const [key, value] of Object.entries(record)) {
        if (!mapping.fields.some((f) => f.source === key)) {
          mapped[key] = value;
        }
      }
    }

    return mapped;
  }

  /**
   * Get the target field name for a source field
   */
  getTargetFieldName(sourceField: string, mapping: MappingConfig): string {
    const fieldMapping = mapping.fields.find((f) => f.source === sourceField);
    return fieldMapping?.target ?? sourceField;
  }

  /**
   * Get the source field name for a target field
   */
  getSourceFieldName(targetField: string, mapping: MappingConfig): string {
    const fieldMapping = mapping.fields.find((f) => f.target === targetField);
    return fieldMapping?.source ?? targetField;
  }

  /**
   * Apply a transformation to a field value
   */
  applyTransform(value: unknown, transform: FieldTransform): unknown {
    if (value === null || value === undefined) {
      return value;
    }

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

  /**
   * Create a bidirectional mapping index for efficient lookups
   */
  createMappingIndex(mapping: MappingConfig): {
    sourceToTarget: Map<string, FieldMapping>;
    targetToSource: Map<string, FieldMapping>;
  } {
    const sourceToTarget = new Map<string, FieldMapping>();
    const targetToSource = new Map<string, FieldMapping>();

    for (const fieldMapping of mapping.fields) {
      sourceToTarget.set(fieldMapping.source, fieldMapping);
      targetToSource.set(fieldMapping.target, fieldMapping);
    }

    return { sourceToTarget, targetToSource };
  }
}
