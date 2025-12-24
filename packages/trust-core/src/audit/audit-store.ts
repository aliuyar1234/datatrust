/**
 * Audit Store
 *
 * Append-only storage for audit log entries.
 * Stores entries in JSON files organized by date.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { AuditEntry } from '../types/index.js';
import { TrustError } from '../errors/index.js';

/**
 * Manages audit log storage on the filesystem.
 *
 * Entries are stored in daily JSON files for efficient querying by date range.
 * Format (new): {baseDir}/{connectorId}/{YYYY-MM-DD}.ndjson (one JSON object per line)
 * Legacy format: {baseDir}/{connectorId}/{YYYY-MM-DD}.json (array of objects)
 */
export class AuditStore {
  private static writeQueue = new Map<string, Promise<void>>();

  constructor(private readonly baseDir: string = './.audit-logs') {}

  /**
   * Get the directory path for a connector
   */
  private getConnectorDir(connectorId: string): string {
    // Sanitize connector ID
    const sanitized = connectorId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, sanitized);
  }

  /**
   * Get the file path for a specific date
   */
  private getFilePath(connectorId: string, date: Date): string {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.getConnectorDir(connectorId), `${dateStr}.ndjson`);
  }

  private getLegacyFilePath(connectorId: string, date: Date): string {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.getConnectorDir(connectorId), `${dateStr}.json`);
  }

  /**
   * Ensure the connector directory exists
   */
  private async ensureDir(connectorId: string): Promise<void> {
    const dir = this.getConnectorDir(connectorId);
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new TrustError({
        code: 'AUDIT_LOG_ERROR',
        message: `Failed to create audit log directory: ${dir}`,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /**
   * Append an entry to the audit log
   */
  async append(entry: AuditEntry): Promise<void> {
    await this.ensureDir(entry.connectorId);
    const filePath = this.getFilePath(entry.connectorId, entry.timestamp);      

    const line = `${JSON.stringify(entry)}\n`;

    try {
      await this.enqueueWrite(filePath, async () => {
        await fs.appendFile(filePath, line, { encoding: 'utf-8', mode: 0o600 });
      });
    } catch (err) {
      throw new TrustError({
        code: 'AUDIT_LOG_ERROR',
        message: `Failed to write audit log entry`,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /**
   * Read entries for a date range
   */
  async readRange(
    connectorId: string,
    from: Date,
    to: Date
  ): Promise<AuditEntry[]> {
    const entries: AuditEntry[] = [];
    const connectorDir = this.getConnectorDir(connectorId);

    // Check if directory exists
    try {
      await fs.access(connectorDir);
    } catch {
      // No logs for this connector yet
      return [];
    }

    // Generate list of dates to check
    const dates = this.getDateRange(from, to);

    for (const date of dates) {
      const filePath = this.getFilePath(connectorId, date);
      const legacyPath = this.getLegacyFilePath(connectorId, date);

      const dayEntries = await this.readEntriesForDay(filePath, legacyPath);
      for (const entry of dayEntries) {
        if (entry.timestamp >= from && entry.timestamp <= to) {
          entries.push(entry);
        }
      }
    }

    // Sort by timestamp descending (newest first)
    return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Read all entries for a connector
   */
  async readAll(connectorId: string): Promise<AuditEntry[]> {
    const connectorDir = this.getConnectorDir(connectorId);
    const entries: AuditEntry[] = [];

    try {
      await fs.access(connectorDir);
    } catch {
      return [];
    }

    const files = await fs.readdir(connectorDir);

    for (const file of files) {
      if (!file.endsWith('.json') && !file.endsWith('.ndjson')) continue;

      const filePath = path.join(connectorDir, file);
      try {
        if (file.endsWith('.ndjson')) {
          entries.push(...(await this.readNdjsonFile(filePath)));
        } else {
          entries.push(...(await this.readLegacyJsonFile(filePath)));
        }
      } catch {
        // Skip invalid files
      }
    }

    return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * List all connectors with audit logs
   */
  async listConnectors(): Promise<string[]> {
    try {
      await fs.access(this.baseDir);
    } catch {
      return [];
    }

    const dirs = await fs.readdir(this.baseDir, { withFileTypes: true });
    return dirs.filter((d) => d.isDirectory()).map((d) => d.name);
  }

  /**
   * Count entries for a connector
   */
  async countEntries(connectorId?: string): Promise<number> {
    if (connectorId) {
      const entries = await this.readAll(connectorId);
      return entries.length;
    }

    // Count across all connectors
    const connectors = await this.listConnectors();
    let total = 0;
    for (const conn of connectors) {
      const entries = await this.readAll(conn);
      total += entries.length;
    }
    return total;
  }

  /**
   * Delete logs older than a certain date
   */
  async deleteOlderThan(date: Date): Promise<number> {
    const connectors = await this.listConnectors();
    let deletedCount = 0;
    const cutoffStr = date.toISOString().split('T')[0] ?? '';

    for (const connectorId of connectors) {
      const connectorDir = this.getConnectorDir(connectorId);
      const files = await fs.readdir(connectorDir);

      for (const file of files) {
        if (!file.endsWith('.json') && !file.endsWith('.ndjson')) continue;
        const fileDate = file.replace(/\.ndjson$|\.json$/, '');

        if (fileDate < cutoffStr) {
          await fs.unlink(path.join(connectorDir, file));
          deletedCount++;
        }
      }
    }

    return deletedCount;
  }

  /**
   * Generate array of dates in range
   */
  private getDateRange(from: Date, to: Date): Date[] {
    const dates: Date[] = [];
    const current = new Date(from);
    current.setHours(0, 0, 0, 0);

    const end = new Date(to);
    end.setHours(23, 59, 59, 999);

    while (current <= end) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  private enqueueWrite(filePath: string, op: () => Promise<void>): Promise<void> {
    const previous = AuditStore.writeQueue.get(filePath) ?? Promise.resolve();
    const next = previous.then(op, op);
    let wrapped: Promise<void>;
    wrapped = next.finally(() => {
      if (AuditStore.writeQueue.get(filePath) === wrapped) {
        AuditStore.writeQueue.delete(filePath);
      }
    });
    AuditStore.writeQueue.set(filePath, wrapped);
    return wrapped;
  }

  private async readEntriesForDay(
    ndjsonPath: string,
    legacyJsonPath: string
  ): Promise<AuditEntry[]> {
    const [ndjsonEntries, legacyEntries] = await Promise.all([
      this.readNdjsonFile(ndjsonPath),
      this.readLegacyJsonFile(legacyJsonPath),
    ]);
    return [...legacyEntries, ...ndjsonEntries];
  }

  private async readNdjsonFile(filePath: string): Promise<AuditEntry[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim().length > 0);
      const entries: AuditEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;
          entry.timestamp = new Date(entry.timestamp);
          entries.push(entry);
        } catch {
          // Skip invalid lines
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  private async readLegacyJsonFile(filePath: string): Promise<AuditEntry[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const dayEntries = JSON.parse(content) as AuditEntry[];
      for (const entry of dayEntries) {
        entry.timestamp = new Date(entry.timestamp);
      }
      return dayEntries;
    } catch {
      return [];
    }
  }
}
