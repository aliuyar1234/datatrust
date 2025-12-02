/**
 * Interface exports for trust-core
 */

export type {
  IConsistencyMonitor,
  ConsistencyCheckOptions,
  ProgressCallback,
} from './consistency-monitor.js';

export type {
  IChangeDetector,
  ChangeDetectorConfig,
  CreateSnapshotOptions,
} from './change-detector.js';

export type {
  IAuditLogger,
  AuditLoggerConfig,
} from './audit-logger.js';

export type {
  IReconciliationEngine,
} from './reconciliation-engine.js';
