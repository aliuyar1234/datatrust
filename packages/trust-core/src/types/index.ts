/**
 * Type exports for trust-core
 */

export type {
  FieldTransform,
  FieldMapping,
  KeyFieldConfig,
  MappingConfig,
} from './field-mapping.js';

export type {
  RecordStatus,
  DifferenceType,
  FieldDifference,
  RecordComparison,
  ComparisonSummary,
  ConnectorInfo,
  ProcessingError,
  ConsistencyReport,
} from './comparison.js';

export type {
  ChangeType,
  DetectionMode,
  ChangeRecord,
  ChangeSummary,
  ChangeReport,
  ChangeDetectorOptions,
  SnapshotInfo,
  SnapshotData,
} from './changes.js';

export type {
  AuditOperation,
  AuditEntry,
  AuditQueryOptions,
  AuditSummary,
  AuditReport,
  AuditLogInput,
} from './audit.js';

export type {
  RuleOperator,
  MatchingRule,
  MatchResult,
  UnmatchedRecord,
  ReconciliationSummary,
  ReconciliationReport,
  ReconciliationOptions,
} from './reconciliation.js';
