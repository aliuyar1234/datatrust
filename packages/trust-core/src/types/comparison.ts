/**
 * Comparison Result Types
 *
 * Types for expressing the results of comparing records across connectors.
 */

import type { Record as DataRecord } from '@datatrust/core';
import type { MappingConfig } from './field-mapping.js';

/** Status of a single record comparison */
export type RecordStatus =
  | 'match'        // Records match completely
  | 'difference'   // Records exist in both but have field differences
  | 'source_only'  // Record exists only in source
  | 'target_only'; // Record exists only in target

/** Type of field difference */
export type DifferenceType =
  | 'value_mismatch'
  | 'missing_in_source'
  | 'missing_in_target'
  | 'type_mismatch';

/** Single field difference */
export interface FieldDifference {
  /** Field name (using source naming convention) */
  field: string;
  /** Value in source connector */
  sourceValue: unknown;
  /** Value in target connector */
  targetValue: unknown;
  /** Type of difference */
  type: DifferenceType;
}

/** Comparison result for a single record pair */
export interface RecordComparison {
  /** Unique identifier used for matching */
  key: string | Record<string, unknown>;
  /** Comparison status */
  status: RecordStatus;
  /** Field-level differences (if status is 'difference') */
  differences?: FieldDifference[];
  /** Source record (if available and requested) */
  sourceRecord?: DataRecord;
  /** Target record (if available and requested) */
  targetRecord?: DataRecord;
}

/** Aggregated comparison statistics */
export interface ComparisonSummary {
  /** Total records processed from source */
  sourceRecordCount: number;
  /** Total records processed from target */
  targetRecordCount: number;
  /** Records that match exactly */
  matchCount: number;
  /** Records with field-level differences */
  differenceCount: number;
  /** Records only in source */
  sourceOnlyCount: number;
  /** Records only in target */
  targetOnlyCount: number;
  /** Breakdown of differences by field */
  differencesByField: Map<string, number>;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/** Connector identification in reports */
export interface ConnectorInfo {
  id: string;
  name: string;
  type: string;
}

/** Processing error during comparison */
export interface ProcessingError {
  /** Error type */
  type: 'read_error' | 'mapping_error' | 'comparison_error';
  /** Error message */
  message: string;
  /** Associated record key if applicable */
  recordKey?: string | Record<string, unknown>;
}

/** Complete consistency check report */
export interface ConsistencyReport {
  /** Unique report ID */
  id: string;
  /** Report generation timestamp */
  timestamp: Date;
  /** Source connector info */
  source: ConnectorInfo;
  /** Target connector info */
  target: ConnectorInfo;
  /** Mapping configuration used */
  mapping: MappingConfig;
  /** Summary statistics */
  summary: ComparisonSummary;
  /** Individual record comparisons */
  records: RecordComparison[];
  /** Any errors encountered during processing */
  errors?: ProcessingError[];
}
