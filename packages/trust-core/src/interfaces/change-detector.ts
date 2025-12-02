/**
 * Change Detector Interface
 *
 * Interface for detecting changes in connector data over time.
 */

import type { IConnector, FilterOptions } from '@datatrust/core';
import type {
  ChangeReport,
  ChangeDetectorOptions,
  SnapshotInfo,
} from '../types/index.js';

/**
 * Configuration for the ChangeDetector
 */
export interface ChangeDetectorConfig {
  /** Directory for storing snapshots (default: './.snapshots') */
  snapshotDir?: string;
}

/**
 * Options for creating a snapshot
 */
export interface CreateSnapshotOptions {
  /** Filter to apply when creating snapshot */
  filter?: FilterOptions;
  /** Description for the snapshot */
  description?: string;
}

/**
 * Change Detector Interface
 *
 * Provides methods for detecting data changes using either
 * timestamp-based or snapshot-based comparison.
 */
export interface IChangeDetector {
  /**
   * Detect changes in connector data.
   *
   * Supports two modes:
   * 1. Timestamp-based: Requires timestampField and since options
   * 2. Snapshot-based: Requires snapshotId option
   *
   * @param connector - The connector to check for changes
   * @param options - Detection options
   * @returns Change report with added/modified/deleted records
   */
  detectChanges(
    connector: IConnector,
    options: ChangeDetectorOptions
  ): Promise<ChangeReport>;

  /**
   * Create a snapshot of current connector data for later comparison.
   *
   * @param connector - The connector to snapshot
   * @param snapshotId - Unique identifier for this snapshot
   * @param options - Optional filter and metadata
   * @returns Snapshot metadata
   */
  createSnapshot(
    connector: IConnector,
    snapshotId: string,
    options?: CreateSnapshotOptions
  ): Promise<SnapshotInfo>;

  /**
   * List all available snapshots for a connector.
   *
   * @param connectorId - The connector ID to list snapshots for
   * @returns Array of snapshot metadata
   */
  listSnapshots(connectorId: string): Promise<SnapshotInfo[]>;

  /**
   * Get metadata for a specific snapshot.
   *
   * @param snapshotId - The snapshot ID
   * @returns Snapshot metadata or undefined if not found
   */
  getSnapshot(snapshotId: string): Promise<SnapshotInfo | undefined>;

  /**
   * Delete a snapshot.
   *
   * @param snapshotId - The snapshot ID to delete
   */
  deleteSnapshot(snapshotId: string): Promise<void>;
}
