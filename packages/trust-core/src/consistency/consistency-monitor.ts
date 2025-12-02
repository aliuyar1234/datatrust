/**
 * ConsistencyMonitor
 *
 * Main class for comparing records across two IConnector instances.
 */

import type { IConnector, Record as DataRecord } from '@datatrust/core';
import type {
  IConsistencyMonitor,
  ConsistencyCheckOptions,
  ProgressCallback,
} from '../interfaces/index.js';
import type {
  ConsistencyReport,
  RecordComparison,
  ComparisonSummary,
} from '../types/index.js';
import { TrustError } from '../errors/index.js';
import { BatchProcessor } from './batch-processor.js';
import { FieldComparator } from './field-comparator.js';
import { RecordMatcher } from './record-matcher.js';

/** Generate unique report ID */
function generateReportId(): string {
  return `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ConsistencyMonitor implements IConsistencyMonitor {
  private fieldComparator: FieldComparator;

  constructor() {
    this.fieldComparator = new FieldComparator();
  }

  /**
   * Register a custom field comparator
   */
  registerComparator(name: string, fn: (a: unknown, b: unknown) => boolean): void {
    this.fieldComparator.registerComparator(name, fn);
  }

  async compare(
    source: IConnector,
    target: IConnector,
    options: ConsistencyCheckOptions,
    onProgress?: ProgressCallback
  ): Promise<ConsistencyReport> {
    const startTime = Date.now();
    const records: RecordComparison[] = [];

    // Use streaming internally but collect results
    const generator = this.compareStream(source, target, options, onProgress);

    let summary: ComparisonSummary | undefined;
    let iterResult = await generator.next();

    // Iterate through all yielded values and capture the return value
    while (!iterResult.done) {
      const comparison = iterResult.value;
      if (!options.differencesOnly || comparison.status !== 'match') {
        // Remove full records unless requested
        if (!options.includeRecords) {
          records.push({
            ...comparison,
            sourceRecord: undefined,
            targetRecord: undefined,
          });
        } else {
          records.push(comparison);
        }
      }
      iterResult = await generator.next();
    }

    // When done=true, value contains the return value (summary)
    summary = iterResult.value;

    return {
      id: generateReportId(),
      timestamp: new Date(),
      source: {
        id: source.config.id,
        name: source.config.name,
        type: source.config.type,
      },
      target: {
        id: target.config.id,
        name: target.config.name,
        type: target.config.type,
      },
      mapping: options.mapping,
      summary: {
        ...summary,
        processingTimeMs: Date.now() - startTime,
      },
      records,
    };
  }

  async *compareStream(
    source: IConnector,
    target: IConnector,
    options: ConsistencyCheckOptions,
    onProgress?: ProgressCallback
  ): AsyncGenerator<RecordComparison, ComparisonSummary> {
    // Validate connectors are connected
    this.validateConnectors(source, target);

    const batchProcessor = new BatchProcessor(options.batchSize ?? 1000);
    const recordMatcher = new RecordMatcher(options.mapping);

    // Phase 1: Load source records
    onProgress?.({ phase: 'loading_source', processedCount: 0 });
    const sourceRecords = await batchProcessor.loadRecords(
      source,
      options.sourceFilter,
      options.maxRecords
    );
    onProgress?.({
      phase: 'loading_source',
      processedCount: sourceRecords.length,
      totalCount: sourceRecords.length,
    });

    // Phase 2: Load target records
    onProgress?.({ phase: 'loading_target', processedCount: 0 });
    const targetRecords = await batchProcessor.loadRecords(
      target,
      options.targetFilter,
      options.maxRecords
    );
    onProgress?.({
      phase: 'loading_target',
      processedCount: targetRecords.length,
      totalCount: targetRecords.length,
    });

    // Phase 3: Match and compare
    onProgress?.({
      phase: 'comparing',
      processedCount: 0,
      totalCount: sourceRecords.length,
    });

    const { matched, sourceOnly, targetOnly, summary } = recordMatcher.matchAndCompare(
      sourceRecords,
      targetRecords,
      this.fieldComparator,
      options.mapping
    );

    // Yield matched pairs
    let processedCount = 0;
    for (const comparison of matched) {
      processedCount++;
      if (processedCount % 100 === 0) {
        onProgress?.({
          phase: 'comparing',
          processedCount,
          totalCount: sourceRecords.length,
        });
      }
      yield comparison;
    }

    // Yield source-only records
    for (const record of sourceOnly) {
      yield {
        key: recordMatcher.extractKey(record, 'source'),
        status: 'source_only',
        sourceRecord: options.includeRecords ? record : undefined,
      };
    }

    // Yield target-only records
    for (const record of targetOnly) {
      yield {
        key: recordMatcher.extractKey(record, 'target'),
        status: 'target_only',
        targetRecord: options.includeRecords ? record : undefined,
      };
    }

    onProgress?.({
      phase: 'complete',
      processedCount: summary.sourceRecordCount,
      totalCount: summary.sourceRecordCount,
    });

    return {
      ...summary,
      processingTimeMs: 0, // Will be set by compare()
    };
  }

  async getDifferences(
    source: IConnector,
    target: IConnector,
    options: Omit<ConsistencyCheckOptions, 'differencesOnly'>
  ): Promise<RecordComparison[]> {
    const report = await this.compare(source, target, {
      ...options,
      differencesOnly: true,
    });
    return report.records;
  }

  private validateConnectors(source: IConnector, target: IConnector): void {
    if (source.state !== 'connected') {
      throw new TrustError({
        code: 'SOURCE_NOT_CONNECTED',
        message: 'Source connector is not connected',
        suggestion: 'Call source.connect() before comparing',
      });
    }
    if (target.state !== 'connected') {
      throw new TrustError({
        code: 'TARGET_NOT_CONNECTED',
        message: 'Target connector is not connected',
        suggestion: 'Call target.connect() before comparing',
      });
    }
  }
}
