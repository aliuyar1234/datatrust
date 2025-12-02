/**
 * Snapshot-based Change Detector
 *
 * Detects changes by comparing current data against a saved snapshot.
 */

import { randomUUID } from 'crypto';
import type { IConnector, Record as DataRecord } from '@datatrust/core';
import type {
  ChangeReport,
  ChangeRecord,
  ChangeDetectorOptions,
  SnapshotData,
  ConnectorInfo,
} from '../types/index.js';
import { TrustError } from '../errors/index.js';
import { SnapshotStore } from './snapshot-store.js';

/**
 * Detects changes by comparing current data against a snapshot.
 *
 * This method can detect:
 * - Added records (in current, not in snapshot)
 * - Deleted records (in snapshot, not in current)
 * - Modified records (in both, but different values)
 */
export class SnapshotDetector {
  constructor(private readonly snapshotStore: SnapshotStore) {}

  /**
   * Detect changes compared to a snapshot.
   *
   * @param connector - The connector to query
   * @param options - Detection options (snapshotId required)
   * @returns Change report with added/modified/deleted records
   */
  async detect(
    connector: IConnector,
    options: ChangeDetectorOptions
  ): Promise<ChangeReport> {
    const { snapshotId, keyField = 'id', trackFields, includeRecords = false, maxRecords } = options;

    if (!snapshotId) {
      throw new TrustError({
        code: 'INVALID_OPTIONS',
        message: 'snapshotId is required for snapshot-based detection',
      });
    }

    const startTime = Date.now();

    // Load the snapshot
    let snapshot: SnapshotData;
    try {
      snapshot = await this.snapshotStore.load(snapshotId);
    } catch (err) {
      throw new TrustError({
        code: 'SNAPSHOT_NOT_FOUND',
        message: `Snapshot '${snapshotId}' not found`,
        cause: err instanceof Error ? err : undefined,
      });
    }

    // Verify connector matches
    if (snapshot.meta.connectorId !== connector.config.id) {
      throw new TrustError({
        code: 'CONNECTOR_MISMATCH',
        message: `Snapshot was created for connector '${snapshot.meta.connectorId}', not '${connector.config.id}'`,
      });
    }

    // Load current records
    const currentResult = await connector.readRecords({
      limit: maxRecords,
    });

    // Build maps for comparison
    const snapshotMap = this.buildRecordMap(snapshot.records, keyField);
    const currentMap = this.buildRecordMap(currentResult.records, keyField);

    const changes: ChangeRecord[] = [];

    // Find added and modified records
    for (const [key, currentRecord] of currentMap.entries()) {
      const snapshotRecord = snapshotMap.get(key);

      if (!snapshotRecord) {
        // Added record
        changes.push(this.createChangeRecord(
          key,
          'added',
          currentRecord,
          undefined,
          trackFields,
          includeRecords
        ));
      } else {
        // Check for modifications
        const changedFields = this.findChangedFields(
          snapshotRecord,
          currentRecord,
          trackFields
        );

        if (changedFields.length > 0) {
          changes.push(this.createChangeRecord(
            key,
            'modified',
            currentRecord,
            snapshotRecord,
            changedFields,
            includeRecords
          ));
        }
      }
    }

    // Find deleted records
    for (const [key, snapshotRecord] of snapshotMap.entries()) {
      if (!currentMap.has(key)) {
        changes.push(this.createChangeRecord(
          key,
          'deleted',
          undefined,
          snapshotRecord,
          trackFields,
          includeRecords
        ));
      }
    }

    // Count by type
    const addedCount = changes.filter((c) => c.type === 'added').length;
    const modifiedCount = changes.filter((c) => c.type === 'modified').length;
    const deletedCount = changes.filter((c) => c.type === 'deleted').length;

    const connectorInfo: ConnectorInfo = {
      id: connector.config.id,
      name: connector.config.name || connector.config.id,
      type: connector.config.type,
    };

    return {
      id: randomUUID(),
      timestamp: new Date(),
      connector: connectorInfo,
      since: snapshot.meta.createdAt,
      mode: 'snapshot',
      summary: {
        addedCount,
        modifiedCount,
        deletedCount,
        totalChanges: changes.length,
      },
      changes,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Build a map of records keyed by the key field
   */
  private buildRecordMap(
    records: DataRecord[],
    keyField: string
  ): Map<string, DataRecord> {
    const map = new Map<string, DataRecord>();

    for (const record of records) {
      const keyValue = record[keyField];
      if (keyValue !== undefined) {
        const key = typeof keyValue === 'object'
          ? JSON.stringify(keyValue)
          : String(keyValue);
        map.set(key, record);
      }
    }

    return map;
  }

  /**
   * Find fields that changed between two records
   */
  private findChangedFields(
    oldRecord: DataRecord,
    newRecord: DataRecord,
    trackFields?: string[]
  ): string[] {
    const fieldsToCheck = trackFields || [
      ...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)]),
    ];

    const changedFields: string[] = [];

    for (const field of fieldsToCheck) {
      const oldValue = oldRecord[field];
      const newValue = newRecord[field];

      if (!this.valuesEqual(oldValue, newValue)) {
        changedFields.push(field);
      }
    }

    return changedFields;
  }

  /**
   * Compare two values for equality
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    // Handle null/undefined
    if (a === b) return true;
    if (a == null || b == null) return false;

    // Handle dates
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }

    // Handle objects/arrays
    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    // Handle primitives
    return a === b;
  }

  /**
   * Create a change record
   */
  private createChangeRecord(
    key: string,
    type: 'added' | 'modified' | 'deleted',
    currentRecord: DataRecord | undefined,
    previousRecord: DataRecord | undefined,
    changedFields: string[] | undefined,
    includeRecords: boolean
  ): ChangeRecord {
    const change: ChangeRecord = {
      key,
      type,
    };

    if (includeRecords) {
      if (currentRecord) change.record = currentRecord;
      if (previousRecord) change.previousRecord = previousRecord;
    }

    if (type === 'modified' && changedFields) {
      change.changedFields = changedFields;
    }

    return change;
  }
}
