/**
 * ConsistencyMonitor Interface
 *
 * Interface for comparing records across two connectors.
 */

import type { IConnector, FilterOptions } from '@datatrust/core';
import type {
  MappingConfig,
  ConsistencyReport,
  RecordComparison,
  ComparisonSummary,
} from '../types/index.js';

/** Options for consistency check */
export interface ConsistencyCheckOptions {
  /** Mapping configuration */
  mapping: MappingConfig;
  /** Filter to apply to source connector */
  sourceFilter?: FilterOptions;
  /** Filter to apply to target connector */
  targetFilter?: FilterOptions;
  /** Batch size for processing (default: 1000) */
  batchSize?: number;
  /** Maximum records to compare (for sampling) */
  maxRecords?: number;
  /** Include full records in output (default: false for memory efficiency) */
  includeRecords?: boolean;
  /** Only return records with differences (default: true) */
  differencesOnly?: boolean;
}

/** Progress callback for long-running comparisons */
export interface ProgressCallback {
  (progress: {
    phase: 'loading_source' | 'loading_target' | 'comparing' | 'complete';
    processedCount: number;
    totalCount?: number;
  }): void;
}

/**
 * Consistency Monitor for comparing data across connectors
 */
export interface IConsistencyMonitor {
  /**
   * Compare records between source and target connectors
   * @param source - Source connector
   * @param target - Target connector
   * @param options - Comparison options
   * @param onProgress - Optional progress callback
   */
  compare(
    source: IConnector,
    target: IConnector,
    options: ConsistencyCheckOptions,
    onProgress?: ProgressCallback
  ): Promise<ConsistencyReport>;

  /**
   * Stream comparison results for memory-efficient processing
   * @yields RecordComparison for each compared record
   */
  compareStream(
    source: IConnector,
    target: IConnector,
    options: ConsistencyCheckOptions,
    onProgress?: ProgressCallback
  ): AsyncGenerator<RecordComparison, ComparisonSummary>;

  /**
   * Get only records with differences (convenience method)
   */
  getDifferences(
    source: IConnector,
    target: IConnector,
    options: Omit<ConsistencyCheckOptions, 'differencesOnly'>
  ): Promise<RecordComparison[]>;
}
