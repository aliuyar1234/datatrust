/**
 * Audit Logging Types
 *
 * Types for tracking and querying data modifications.
 */

/** Type of operation performed */
export type AuditOperation = 'create' | 'update' | 'delete';

/**
 * Single audit log entry
 */
export interface AuditEntry {
  /** Unique entry ID (UUID) */
  id: string;
  /** When the operation occurred */
  timestamp: Date;
  /** Connector where operation was performed */
  connectorId: string;
  /** Type of operation */
  operation: AuditOperation;
  /** Key of the affected record */
  recordKey: string | Record<string, unknown>;
  /** User who performed the operation (optional) */
  user?: string;
  /** Record state before operation (for update/delete) */
  before?: Record<string, unknown>;
  /** Record state after operation (for create/update) */
  after?: Record<string, unknown>;
  /** Fields that changed (for update) */
  changedFields?: string[];
  /** Additional metadata (IP, session, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Options for querying audit logs
 */
export interface AuditQueryOptions {
  /** Filter by connector ID */
  connectorId?: string;
  /** Filter by operation type(s) */
  operation?: AuditOperation | AuditOperation[];
  /** Filter by record key */
  recordKey?: string;
  /** Filter by user */
  user?: string;
  /** Filter from this date (inclusive) */
  from?: Date;
  /** Filter to this date (inclusive) */
  to?: Date;
  /** Maximum entries to return */
  limit?: number;
  /** Skip first N entries */
  offset?: number;
}

/**
 * Summary statistics for audit report
 */
export interface AuditSummary {
  createCount: number;
  updateCount: number;
  deleteCount: number;
  totalCount: number;
}

/**
 * Audit query result report
 */
export interface AuditReport {
  /** Unique report ID */
  id: string;
  /** Report generation timestamp */
  timestamp: Date;
  /** Query options used */
  query: AuditQueryOptions;
  /** Matching audit entries */
  entries: AuditEntry[];
  /** Total count (may exceed entries if limited) */
  totalCount: number;
  /** Summary by operation type */
  summary: AuditSummary;
}

/**
 * Input for logging an operation (without auto-generated fields)
 */
export type AuditLogInput = Omit<AuditEntry, 'id' | 'timestamp'>;
