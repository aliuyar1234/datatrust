/**
 * Audit Query Engine
 *
 * Filters and queries audit log entries.
 */

import type {
  AuditEntry,
  AuditQueryOptions,
  AuditReport,
  AuditSummary,
} from '../types/index.js';
import { randomUUID } from 'crypto';
import { AuditStore } from './audit-store.js';

/**
 * Handles filtering and querying of audit log entries.
 */
export class AuditQuery {
  constructor(private readonly store: AuditStore) {}

  /**
   * Execute a query against the audit log.
   */
  async execute(options: AuditQueryOptions): Promise<AuditReport> {
    // Determine date range
    const now = new Date();
    const from = options.from ?? new Date(0); // Beginning of time
    const to = options.to ?? now;

    // Load entries
    let entries: AuditEntry[];
    if (options.connectorId) {
      entries = await this.store.readRange(options.connectorId, from, to);
    } else {
      // Load from all connectors
      const connectors = await this.store.listConnectors();
      entries = [];
      for (const connectorId of connectors) {
        const connEntries = await this.store.readRange(connectorId, from, to);
        entries.push(...connEntries);
      }
      // Re-sort after merging
      entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    // Apply filters
    entries = this.applyFilters(entries, options);

    // Calculate summary before pagination
    const summary = this.calculateSummary(entries);
    const totalCount = entries.length;

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    entries = entries.slice(offset, offset + limit);

    return {
      id: randomUUID(),
      timestamp: now,
      query: options,
      entries,
      totalCount,
      summary,
    };
  }

  /**
   * Apply query filters to entries
   */
  private applyFilters(
    entries: AuditEntry[],
    options: AuditQueryOptions
  ): AuditEntry[] {
    return entries.filter((entry) => {
      // Filter by operation
      if (options.operation) {
        const ops = Array.isArray(options.operation)
          ? options.operation
          : [options.operation];
        if (!ops.includes(entry.operation)) {
          return false;
        }
      }

      // Filter by record key
      if (options.recordKey !== undefined) {
        const entryKey =
          typeof entry.recordKey === 'string'
            ? entry.recordKey
            : JSON.stringify(entry.recordKey);
        if (entryKey !== options.recordKey) {
          return false;
        }
      }

      // Filter by user
      if (options.user !== undefined) {
        if (entry.user !== options.user) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(entries: AuditEntry[]): AuditSummary {
    let createCount = 0;
    let updateCount = 0;
    let deleteCount = 0;

    for (const entry of entries) {
      switch (entry.operation) {
        case 'create':
          createCount++;
          break;
        case 'update':
          updateCount++;
          break;
        case 'delete':
          deleteCount++;
          break;
      }
    }

    return {
      createCount,
      updateCount,
      deleteCount,
      totalCount: entries.length,
    };
  }
}
