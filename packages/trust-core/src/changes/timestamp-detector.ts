/**
 * Timestamp-based Change Detector
 *
 * Detects changes by querying records with a timestamp field
 * greater than a specified date.
 */

import { randomUUID } from 'crypto';
import type { IConnector, Record as DataRecord } from '@datatrust/core';
import type {
  ChangeReport,
  ChangeRecord,
  ChangeDetectorOptions,
  ConnectorInfo,
} from '../types/index.js';
import { TrustError } from '../errors/index.js';

/**
 * Detects changes using timestamp-based filtering.
 *
 * This is the preferred detection method when the data source
 * has a reliable modification timestamp field (e.g., updated_at).
 *
 * Note: This method cannot distinguish between 'added' and 'modified'
 * records without additional context (like a created_at field).
 */
export class TimestampDetector {
  /**
   * Detect changes since a timestamp.
   *
   * @param connector - The connector to query
   * @param options - Detection options (timestampField and since required)
   * @returns Change report with detected changes
   */
  async detect(
    connector: IConnector,
    options: ChangeDetectorOptions
  ): Promise<ChangeReport> {
    const { timestampField, since, keyField = 'id', trackFields, includeRecords = false, maxRecords } = options;

    if (!timestampField) {
      throw new TrustError({
        code: 'INVALID_OPTIONS',
        message: 'timestampField is required for timestamp-based detection',
      });
    }

    if (!since) {
      throw new TrustError({
        code: 'INVALID_OPTIONS',
        message: 'since date is required for timestamp-based detection',
      });
    }

    // Validate that 'since' is a valid Date
    if (!(since instanceof Date) || isNaN(since.getTime())) {
      throw new TrustError({
        code: 'INVALID_OPTIONS',
        message: 'since must be a valid Date object',
        suggestion: 'Provide a valid Date, e.g., new Date("2024-01-15T00:00:00Z")',
      });
    }

    const startTime = Date.now();

    // Query records modified since the specified date
    const result = await connector.readRecords({
      where: [
        {
          field: timestampField,
          op: 'gt',
          value: since.toISOString(),
        },
      ],
      limit: maxRecords,
    });

    // Build change records
    const changes: ChangeRecord[] = result.records.map((record) => {
      const key = this.extractKey(record, keyField);
      const changedAt = this.extractDate(record, timestampField);

      const changeRecord: ChangeRecord = {
        key,
        type: 'modified', // We can't distinguish added vs modified without a snapshot
        changedAt,
      };

      if (includeRecords) {
        changeRecord.record = record;
      }

      if (trackFields && trackFields.length > 0) {
        changeRecord.changedFields = trackFields.filter(
          (f) => record[f] !== undefined
        );
      }

      return changeRecord;
    });

    const connectorInfo: ConnectorInfo = {
      id: connector.config.id,
      name: connector.config.name || connector.config.id,
      type: connector.config.type,
    };

    return {
      id: randomUUID(),
      timestamp: new Date(),
      connector: connectorInfo,
      since,
      mode: 'timestamp',
      summary: {
        addedCount: 0, // Cannot determine without snapshot
        modifiedCount: changes.length,
        deletedCount: 0, // Cannot detect without snapshot
        totalChanges: changes.length,
      },
      changes,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Extract the key value(s) from a record
   */
  private extractKey(
    record: DataRecord,
    keyField: string
  ): string | Record<string, unknown> {
    const value = record[keyField];
    if (value === undefined) {
      return 'unknown';
    }
    return typeof value === 'object' ? (value as Record<string, unknown>) : String(value);
  }

  /**
   * Extract a date from a record field
   */
  private extractDate(record: DataRecord, field: string): Date | undefined {
    const value = record[field];
    if (!value) return undefined;

    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return isNaN(date.getTime()) ? undefined : date;
    }
    return undefined;
  }
}
