# @datatrust/trust-core

Data Trust Layer for MCP Enterprise Connectors. Provides consistency monitoring, change detection, audit logging, and record reconciliation.

## Features

| Feature | Use Case | MCP Tool |
|---------|----------|----------|
| **ConsistencyMonitor** | Compare data between systems | `compare_records` |
| **ChangeDetector** | Track changes over time | `detect_changes`, `create_snapshot` |
| **AuditLogger** | Compliance & audit trail | `query_audit_log` |
| **ReconciliationEngine** | Match payments with invoices | `reconcile_records` |

## Installation

```bash
pnpm add @datatrust/trust-core
```

## Usage

### ConsistencyMonitor

Compare records between two connectors to find inconsistencies.

```typescript
import { createConsistencyMonitor, MCPFormatter } from '@datatrust/trust-core';

const monitor = createConsistencyMonitor();
const formatter = new MCPFormatter();

const report = await monitor.compare(postgresConnector, hubspotConnector, {
  mapping: {
    fields: [
      { source: 'email', target: 'contact_email', transform: 'lowercase' },
      { source: 'name', target: 'full_name' },
    ],
    keyFields: { source: 'id', target: 'customer_id' },
  },
  differencesOnly: true,
});

console.log(formatter.formatAsText(report));
```

### ChangeDetector

Detect what changed in a data source since a specific time.

```typescript
import { createChangeDetector, MCPFormatter } from '@datatrust/trust-core';

const detector = createChangeDetector('./snapshots');
const formatter = new MCPFormatter();

// Option 1: Timestamp-based (if source has updated_at field)
const report = await detector.detectChanges(connector, {
  timestampField: 'updated_at',
  since: new Date('2024-01-15T18:00:00Z'),
});

// Option 2: Snapshot-based
await detector.createSnapshot(connector, 'baseline-2024-01-15');
// ... time passes ...
const report = await detector.detectChanges(connector, {
  snapshotId: 'baseline-2024-01-15',
});

console.log(formatter.formatChangeReport(report));
```

### AuditLogger

Log and query data modifications for compliance.

```typescript
import { createAuditLogger, MCPFormatter } from '@datatrust/trust-core';

const logger = createAuditLogger('./audit-logs', 90); // 90 day retention
const formatter = new MCPFormatter();

// Log an operation
await logger.log({
  connectorId: 'customers',
  operation: 'update',
  recordKey: 'CUST-123',
  user: 'admin@example.com',
  before: { name: 'Old Name' },
  after: { name: 'New Name' },
  changedFields: ['name'],
});

// Query audit log
const report = await logger.query({
  connectorId: 'customers',
  operation: 'update',
  from: new Date('2024-01-01'),
  limit: 100,
});

console.log(formatter.formatAuditReport(report));
```

### ReconciliationEngine

Match records between two sources using configurable rules.

```typescript
import { createReconciliationEngine, MCPFormatter } from '@datatrust/trust-core';

const engine = createReconciliationEngine();
const formatter = new MCPFormatter();

const report = await engine.reconcile(bankConnector, invoiceConnector, {
  rules: [
    {
      name: 'amount_match',
      sourceField: 'amount',
      targetField: 'total',
      operator: 'equals_tolerance',
      weight: 40,
      required: true,
      options: { tolerance: 0.01 },
    },
    {
      name: 'reference_contains_invoice',
      sourceField: 'reference',
      targetField: 'invoice_number',
      operator: 'contains',
      weight: 35,
    },
    {
      name: 'date_in_range',
      sourceField: 'booking_date',
      targetField: 'due_date',
      operator: 'date_range',
      weight: 25,
      options: { dateRangeDays: 7 },
    },
  ],
  minConfidence: 60,
});

console.log(formatter.formatReconciliationReport(report));
```

## Rule Operators

| Operator | Description | Options |
|----------|-------------|---------|
| `equals` | Exact match | `caseSensitive` |
| `equals_tolerance` | Numeric match within tolerance | `tolerance` (e.g., 0.01) |
| `contains` | String contains (bidirectional) | `caseSensitive` |
| `regex` | Pattern match | - |
| `date_range` | Date within ±N days | `dateRangeDays` |

## Error Handling

All modules throw `TrustError` with actionable messages:

```typescript
import { TrustError } from '@datatrust/trust-core';

try {
  await monitor.compare(source, target, options);
} catch (err) {
  if (err instanceof TrustError) {
    console.log(err.code);              // e.g., 'SOURCE_NOT_CONNECTED'
    console.log(err.toActionableMessage()); // Formatted for LLM consumption
  }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `SOURCE_NOT_CONNECTED` | Source connector not connected |
| `TARGET_NOT_CONNECTED` | Target connector not connected |
| `CONNECTOR_NOT_CONNECTED` | Connector not connected |
| `CONNECTOR_MISMATCH` | Snapshot was for different connector |
| `MAPPING_ERROR` | Field mapping configuration error |
| `KEY_FIELD_MISSING` | Key field not found in record |
| `COMPARISON_FAILED` | Comparison operation failed |
| `BATCH_PROCESSING_ERROR` | Error during batch processing |
| `INVALID_OPTIONS` | Invalid configuration options |
| `SNAPSHOT_ERROR` | Snapshot operation failed |
| `SNAPSHOT_EXISTS` | Snapshot ID already exists |
| `SNAPSHOT_NOT_FOUND` | Snapshot not found |
| `AUDIT_LOG_ERROR` | Audit log operation failed |
| `AUDIT_QUERY_ERROR` | Audit query failed |
| `RECONCILIATION_ERROR` | Reconciliation operation failed |
| `INVALID_RULE` | Invalid matching rule |

## API Reference

### Factory Functions

```typescript
createConsistencyMonitor(): ConsistencyMonitor
createChangeDetector(snapshotDir?: string): ChangeDetector
createAuditLogger(logDir?: string, retentionDays?: number): AuditLogger
createReconciliationEngine(): ReconciliationEngine
```

### MCPFormatter

```typescript
class MCPFormatter {
  format(report: ConsistencyReport): MCPFormattedReport
  formatAsText(report: ConsistencyReport): string
  formatChangeReport(report: ChangeReport): string
  formatAuditReport(report: AuditReport): string
  formatReconciliationReport(report: ReconciliationReport): string
}
```

## License

BSL 1.1 - See [LICENSE.md](../../LICENSE.md)
