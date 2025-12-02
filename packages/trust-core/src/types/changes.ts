/**
 * Change Detection Types
 *
 * Types for tracking changes in data over time.
 */

import type { Record as DataRecord } from '@datatrust/core';
import type { ConnectorInfo } from './comparison.js';

/** Type of change detected */
export type ChangeType = 'added' | 'modified' | 'deleted';

/** Detection mode used */
export type DetectionMode = 'timestamp' | 'snapshot';

/** Single changed record */
export interface ChangeRecord {
  /** Record key for identification */
  key: string | Record<string, unknown>;
  /** Type of change */
  type: ChangeType;
  /** Current record (for added/modified) */
  record?: DataRecord;
  /** Previous record (for modified/deleted) */
  previousRecord?: DataRecord;
  /** Fields that changed (for modified) */
  changedFields?: string[];
  /** Timestamp when change was detected (if available) */
  changedAt?: Date;
}

/** Summary statistics for change report */
export interface ChangeSummary {
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  totalChanges: number;
}

/** Complete change detection report */
export interface ChangeReport {
  /** Unique report ID */
  id: string;
  /** Report generation timestamp */
  timestamp: Date;
  /** Connector info */
  connector: ConnectorInfo;
  /** Changes detected since this time */
  since: Date;
  /** Detection mode used */
  mode: DetectionMode;
  /** Summary statistics */
  summary: ChangeSummary;
  /** Individual change records */
  changes: ChangeRecord[];
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/** Options for change detection */
export interface ChangeDetectorOptions {
  /** Timestamp field name for timestamp-based detection (e.g. 'updated_at') */
  timestampField?: string;
  /** Snapshot ID to compare against for snapshot-based detection */
  snapshotId?: string;
  /** Compare since this date (required for timestamp mode) */
  since?: Date;
  /** Primary key field (default: 'id') */
  keyField?: string;
  /** Fields to track for modification detection (default: all) */
  trackFields?: string[];
  /** Include full records in output (default: false) */
  includeRecords?: boolean;
  /** Max records to process */
  maxRecords?: number;
}

/** Snapshot metadata */
export interface SnapshotInfo {
  /** Unique snapshot ID */
  id: string;
  /** Connector ID this snapshot belongs to */
  connectorId: string;
  /** When snapshot was created */
  createdAt: Date;
  /** Number of records in snapshot */
  recordCount: number;
  /** File path where snapshot is stored */
  filePath: string;
}

/** Snapshot data structure */
export interface SnapshotData {
  /** Snapshot metadata */
  meta: SnapshotInfo;
  /** Record data */
  records: DataRecord[];
}
