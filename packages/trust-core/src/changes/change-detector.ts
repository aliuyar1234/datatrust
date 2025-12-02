/**
 * Change Detector
 *
 * Main facade for detecting changes in connector data.
 * Supports both timestamp-based and snapshot-based detection.
 */

import type { IConnector, FilterOptions } from '@datatrust/core';
import type {
  IChangeDetector,
  ChangeDetectorConfig,
  CreateSnapshotOptions,
} from '../interfaces/index.js';
import type {
  ChangeReport,
  ChangeDetectorOptions,
  SnapshotInfo,
} from '../types/index.js';
import { TrustError } from '../errors/index.js';
import { SnapshotStore } from './snapshot-store.js';
import { TimestampDetector } from './timestamp-detector.js';
import { SnapshotDetector } from './snapshot-detector.js';

/**
 * Change Detector Implementation
 *
 * Provides a unified interface for detecting data changes.
 * Automatically selects the appropriate detection strategy based on options.
 */
export class ChangeDetector implements IChangeDetector {
  private readonly snapshotStore: SnapshotStore;
  private readonly timestampDetector: TimestampDetector;
  private readonly snapshotDetector: SnapshotDetector;

  constructor(config: ChangeDetectorConfig = {}) {
    const snapshotDir = config.snapshotDir ?? './.snapshots';
    this.snapshotStore = new SnapshotStore(snapshotDir);
    this.timestampDetector = new TimestampDetector();
    this.snapshotDetector = new SnapshotDetector(this.snapshotStore);
  }

  /**
   * Detect changes in connector data.
   *
   * Mode selection:
   * - If timestampField AND since are provided → timestamp-based detection
   * - If snapshotId is provided → snapshot-based detection
   * - Otherwise → error
   */
  async detectChanges(
    connector: IConnector,
    options: ChangeDetectorOptions
  ): Promise<ChangeReport> {
    // Validate connector state
    if (connector.state !== 'connected') {
      throw new TrustError({
        code: 'CONNECTOR_NOT_CONNECTED',
        message: `Connector '${connector.config.id}' is not connected (state: ${connector.state})`,
      });
    }

    // Determine detection mode
    const hasTimestamp = options.timestampField && options.since;
    const hasSnapshot = !!options.snapshotId;

    if (hasTimestamp) {
      return this.timestampDetector.detect(connector, options);
    }

    if (hasSnapshot) {
      return this.snapshotDetector.detect(connector, options);
    }

    throw new TrustError({
      code: 'INVALID_OPTIONS',
      message: 'Either (timestampField + since) or snapshotId is required for change detection',
      suggestion: 'Provide timestampField and since for timestamp-based detection, or snapshotId for snapshot-based detection',
    });
  }

  /**
   * Create a snapshot of current connector data.
   */
  async createSnapshot(
    connector: IConnector,
    snapshotId: string,
    options: CreateSnapshotOptions = {}
  ): Promise<SnapshotInfo> {
    // Validate connector state
    if (connector.state !== 'connected') {
      throw new TrustError({
        code: 'CONNECTOR_NOT_CONNECTED',
        message: `Connector '${connector.config.id}' is not connected (state: ${connector.state})`,
      });
    }

    // Build filter
    const filter: FilterOptions = options.filter ?? {};

    // Read all records
    const result = await connector.readRecords(filter);

    // Save snapshot
    return this.snapshotStore.save(
      connector.config.id,
      snapshotId,
      result.records,
      options.description
    );
  }

  /**
   * List all snapshots for a connector.
   */
  async listSnapshots(connectorId: string): Promise<SnapshotInfo[]> {
    return this.snapshotStore.list(connectorId);
  }

  /**
   * Get metadata for a specific snapshot.
   */
  async getSnapshot(snapshotId: string): Promise<SnapshotInfo | undefined> {
    return this.snapshotStore.getMeta(snapshotId);
  }

  /**
   * Delete a snapshot.
   */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    return this.snapshotStore.delete(snapshotId);
  }
}
