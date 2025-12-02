/**
 * Audit Logger
 *
 * Main class for logging and querying data modifications.
 */

import { randomUUID } from 'crypto';
import type {
  IAuditLogger,
  AuditLoggerConfig,
} from '../interfaces/index.js';
import type {
  AuditEntry,
  AuditLogInput,
  AuditQueryOptions,
  AuditReport,
} from '../types/index.js';
import { AuditStore } from './audit-store.js';
import { AuditQuery } from './audit-query.js';

/**
 * Audit Logger Implementation
 *
 * Provides audit trail functionality for data operations.
 */
export class AuditLogger implements IAuditLogger {
  private readonly store: AuditStore;
  private readonly queryEngine: AuditQuery;
  private readonly retentionDays?: number;

  constructor(config: AuditLoggerConfig = {}) {
    const logDir = config.logDir ?? './.audit-logs';
    this.store = new AuditStore(logDir);
    this.queryEngine = new AuditQuery(this.store);
    this.retentionDays = config.retentionDays;
  }

  /**
   * Log an operation to the audit trail.
   */
  async log(input: AuditLogInput): Promise<AuditEntry> {
    const entry: AuditEntry = {
      ...input,
      id: randomUUID(),
      timestamp: new Date(),
    };

    await this.store.append(entry);

    // Run retention cleanup if configured
    if (this.retentionDays) {
      await this.runRetentionCleanup();
    }

    return entry;
  }

  /**
   * Query the audit log.
   */
  async query(options: AuditQueryOptions): Promise<AuditReport> {
    return this.queryEngine.execute(options);
  }

  /**
   * Get total entry count.
   */
  async getEntryCount(connectorId?: string): Promise<number> {
    return this.store.countEntries(connectorId);
  }

  /**
   * Run retention cleanup (delete old logs).
   */
  private async runRetentionCleanup(): Promise<void> {
    if (!this.retentionDays) return;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    await this.store.deleteOlderThan(cutoffDate);
  }
}
