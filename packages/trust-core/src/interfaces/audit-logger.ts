/**
 * Audit Logger Interface
 *
 * Interface for logging and querying data modifications.
 */

import type {
  AuditEntry,
  AuditLogInput,
  AuditQueryOptions,
  AuditReport,
} from '../types/index.js';

/**
 * Configuration for the AuditLogger
 */
export interface AuditLoggerConfig {
  /** Directory for storing audit logs (default: './.audit-logs') */
  logDir?: string;
  /** Auto-delete logs older than N days (optional, no auto-cleanup if not set) */
  retentionDays?: number;
}

/**
 * Audit Logger Interface
 *
 * Provides methods for logging operations and querying the audit trail.
 */
export interface IAuditLogger {
  /**
   * Log an operation to the audit trail.
   *
   * @param entry - The operation details to log
   * @returns The complete audit entry with generated ID and timestamp
   */
  log(entry: AuditLogInput): Promise<AuditEntry>;

  /**
   * Query the audit log with filters.
   *
   * @param options - Query filters
   * @returns Audit report with matching entries
   */
  query(options: AuditQueryOptions): Promise<AuditReport>;

  /**
   * Get the total number of audit entries.
   *
   * @param connectorId - Optional filter by connector
   * @returns Entry count
   */
  getEntryCount(connectorId?: string): Promise<number>;
}
