/**
 * @datatrust/trust-core
 *
 * Data Trust Layer for MCP Enterprise Connectors
 * Provides consistency monitoring, change detection, and reconciliation.
 */

// Types
export * from './types/index.js';

// Interfaces
export * from './interfaces/index.js';

// Consistency Module
import { ConsistencyMonitor as _ConsistencyMonitor } from './consistency/index.js';
export {
  ConsistencyMonitor,
  BatchProcessor,
  FieldMapper,
  FieldComparator,
  RecordMatcher,
} from './consistency/index.js';
export type { ComparatorFn } from './consistency/index.js';

// Change Detection Module
import { ChangeDetector as _ChangeDetector } from './changes/index.js';
export {
  ChangeDetector,
  SnapshotStore,
  TimestampDetector,
  SnapshotDetector,
} from './changes/index.js';

// Audit Module
import { AuditLogger as _AuditLogger } from './audit/index.js';
export {
  AuditLogger,
  AuditStore,
  AuditQuery,
} from './audit/index.js';

// Reconciliation Module
import { ReconciliationEngine as _ReconciliationEngine } from './reconciliation/index.js';
export {
  ReconciliationEngine,
  MatchingRuleEvaluator,
  ConfidenceScorer,
} from './reconciliation/index.js';
export type { RuleEvaluationResult } from './reconciliation/index.js';

// Formatters
export { MCPFormatter } from './formatters/index.js';
export type { MCPSummary, MCPFormattedReport } from './formatters/index.js';

// Errors
export { TrustError } from './errors/index.js';
export type { TrustErrorCode, TrustErrorDetails } from './errors/index.js';

/**
 * Factory function to create a ConsistencyMonitor
 */
export function createConsistencyMonitor(): _ConsistencyMonitor {
  return new _ConsistencyMonitor();
}

/**
 * Factory function to create a ChangeDetector
 *
 * @param snapshotDir - Directory to store snapshots (default: './.snapshots')
 */
export function createChangeDetector(snapshotDir?: string): _ChangeDetector {
  return new _ChangeDetector({ snapshotDir });
}

/**
 * Factory function to create an AuditLogger
 *
 * @param logDir - Directory to store audit logs (default: './.audit-logs')
 * @param retentionDays - Auto-delete logs older than N days (optional)
 */
export function createAuditLogger(logDir?: string, retentionDays?: number): _AuditLogger {
  return new _AuditLogger({ logDir, retentionDays });
}

/**
 * Factory function to create a ReconciliationEngine
 */
export function createReconciliationEngine(): _ReconciliationEngine {
  return new _ReconciliationEngine();
}
