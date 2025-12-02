/**
 * BatchProcessor
 *
 * Handles pagination and streaming for large datasets.
 */

import type { IConnector, FilterOptions, Record as DataRecord } from '@datatrust/core';
import { TrustError } from '../errors/index.js';

/** Default maximum records to prevent unbounded memory usage */
const DEFAULT_MAX_RECORDS = 100_000;

/** Absolute maximum records (safety limit) */
const ABSOLUTE_MAX_RECORDS = 1_000_000;

export class BatchProcessor {
  private batchSize: number;
  private defaultMaxRecords: number;

  constructor(batchSize: number = 1000, defaultMaxRecords: number = DEFAULT_MAX_RECORDS) {
    this.batchSize = batchSize;
    this.defaultMaxRecords = Math.min(defaultMaxRecords, ABSOLUTE_MAX_RECORDS);
  }

  /**
   * Load records from a connector with pagination and memory protection.
   *
   * IMPORTANT: This method enforces a maximum record limit to prevent OOM.
   * For truly large datasets, use streamBatches() instead.
   *
   * @param connector - The connector to read from
   * @param filter - Optional filter options
   * @param maxRecords - Maximum records to load (default: 100,000, max: 1,000,000)
   */
  async loadRecords(
    connector: IConnector,
    filter?: FilterOptions,
    maxRecords?: number
  ): Promise<DataRecord[]> {
    // Enforce memory limit
    const limit = Math.min(
      maxRecords ?? this.defaultMaxRecords,
      ABSOLUTE_MAX_RECORDS
    );

    const records: DataRecord[] = [];

    for await (const batch of this.streamBatches(connector, filter, limit)) {
      records.push(...batch);
      if (records.length >= limit) {
        // Trim to exact limit and warn if more data exists
        const trimmed = records.slice(0, limit);
        if (records.length > limit) {
          console.warn(
            `[BatchProcessor] Loaded ${limit} records (limit reached). More records may exist.`
          );
        }
        return trimmed;
      }
    }

    return records;
  }

  /**
   * Stream records in batches with cursor-based pagination support.
   *
   * Supports both offset-based and cursor-based pagination depending on
   * what the connector returns.
   *
   * @param connector - The connector to read from
   * @param filter - Optional filter options
   * @param maxRecords - Optional maximum total records to stream
   */
  async *streamBatches(
    connector: IConnector,
    filter?: FilterOptions,
    maxRecords?: number
  ): AsyncGenerator<DataRecord[]> {
    let cursor: string | undefined = undefined;
    let offset = 0;
    let hasMore = true;
    let totalRecords = 0;

    while (hasMore) {
      // Determine how many records to fetch this batch
      const remaining = maxRecords ? maxRecords - totalRecords : undefined;
      const batchLimit = remaining ? Math.min(this.batchSize, remaining) : this.batchSize;

      if (batchLimit <= 0) {
        break;
      }

      const result = await connector.readRecords({
        ...filter,
        cursor,
        offset: cursor ? undefined : offset, // Only use offset if no cursor
        limit: batchLimit,
      });

      if (result.records.length > 0) {
        yield result.records;
        totalRecords += result.records.length;
      }

      // Prefer cursor-based pagination if available
      if (result.nextCursor) {
        cursor = result.nextCursor;
        hasMore = true;
      } else {
        // Fall back to offset-based
        hasMore = result.hasMore ?? (result.records.length === batchLimit);
        offset += result.records.length;
      }

      // Stop if we've reached the max
      if (maxRecords && totalRecords >= maxRecords) {
        break;
      }

      // Safety check to prevent infinite loops
      if (result.records.length === 0) {
        break;
      }
    }
  }
}
