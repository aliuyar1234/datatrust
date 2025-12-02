/**
 * Snapshot Store
 *
 * Manages storage and retrieval of data snapshots for change detection.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { Record as DataRecord } from '@datatrust/core';
import type { SnapshotInfo, SnapshotData } from '../types/index.js';
import { TrustError } from '../errors/index.js';

/**
 * Manages snapshot storage on the filesystem.
 *
 * Snapshots are stored as JSON files with metadata.
 */
export class SnapshotStore {
  constructor(private readonly baseDir: string = './.snapshots') {}

  /**
   * Get the file path for a snapshot
   */
  private getFilePath(snapshotId: string): string {
    // Sanitize snapshot ID to prevent directory traversal
    const sanitized = snapshotId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `${sanitized}.json`);
  }

  /**
   * Ensure the snapshot directory exists
   */
  private async ensureDir(): Promise<void> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
    } catch (err) {
      throw new TrustError({
        code: 'SNAPSHOT_ERROR',
        message: `Failed to create snapshot directory: ${this.baseDir}`,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /**
   * Save a snapshot to disk
   */
  async save(
    connectorId: string,
    snapshotId: string,
    records: DataRecord[],
    description?: string
  ): Promise<SnapshotInfo> {
    await this.ensureDir();

    const filePath = this.getFilePath(snapshotId);

    // Check if snapshot already exists
    try {
      await fs.access(filePath);
      throw new TrustError({
        code: 'SNAPSHOT_EXISTS',
        message: `Snapshot '${snapshotId}' already exists`,
        context: { snapshotId, filePath },
      });
    } catch (err) {
      // File doesn't exist, which is what we want
      if (err instanceof TrustError) throw err;
    }

    const meta: SnapshotInfo = {
      id: snapshotId,
      connectorId,
      createdAt: new Date(),
      recordCount: records.length,
      filePath,
    };

    const data: SnapshotData & { description?: string } = {
      meta,
      records,
      description,
    };

    try {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      throw new TrustError({
        code: 'SNAPSHOT_ERROR',
        message: `Failed to save snapshot '${snapshotId}'`,
        cause: err instanceof Error ? err : undefined,
      });
    }

    return meta;
  }

  /**
   * Load a snapshot from disk
   */
  async load(snapshotId: string): Promise<SnapshotData> {
    const filePath = this.getFilePath(snapshotId);

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      throw new TrustError({
        code: 'SNAPSHOT_NOT_FOUND',
        message: `Snapshot '${snapshotId}' not found`,
        context: { snapshotId, filePath },
        cause: err instanceof Error ? err : undefined,
      });
    }

    try {
      const data = JSON.parse(content) as SnapshotData;
      // Restore Date objects
      data.meta.createdAt = new Date(data.meta.createdAt);
      return data;
    } catch (err) {
      throw new TrustError({
        code: 'SNAPSHOT_ERROR',
        message: `Failed to parse snapshot '${snapshotId}'`,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /**
   * Get metadata for a snapshot without loading all records
   */
  async getMeta(snapshotId: string): Promise<SnapshotInfo | undefined> {
    try {
      const data = await this.load(snapshotId);
      return data.meta;
    } catch (err) {
      if (err instanceof TrustError && err.code === 'SNAPSHOT_NOT_FOUND') {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * List all snapshots for a connector
   */
  async list(connectorId?: string): Promise<SnapshotInfo[]> {
    try {
      await fs.access(this.baseDir);
    } catch {
      // Directory doesn't exist, return empty list
      return [];
    }

    const files = await fs.readdir(this.baseDir);
    const snapshots: SnapshotInfo[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(this.baseDir, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content) as SnapshotData;
        data.meta.createdAt = new Date(data.meta.createdAt);

        // Filter by connector if specified
        if (!connectorId || data.meta.connectorId === connectorId) {
          snapshots.push(data.meta);
        }
      } catch {
        // Skip invalid files
        continue;
      }
    }

    // Sort by creation date, newest first
    return snapshots.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  /**
   * Delete a snapshot
   */
  async delete(snapshotId: string): Promise<void> {
    const filePath = this.getFilePath(snapshotId);

    try {
      await fs.unlink(filePath);
    } catch (err) {
      throw new TrustError({
        code: 'SNAPSHOT_NOT_FOUND',
        message: `Snapshot '${snapshotId}' not found`,
        context: { snapshotId, filePath },
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /**
   * Check if a snapshot exists
   */
  async exists(snapshotId: string): Promise<boolean> {
    const filePath = this.getFilePath(snapshotId);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
