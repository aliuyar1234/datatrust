/**
 * MCP Server Implementation
 *
 * Generic MCP server that exposes connector tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConnectorError } from '@datatrust/core';
import { createConsistencyMonitor, createChangeDetector, createAuditLogger, createReconciliationEngine, MCPFormatter, TrustError } from '@datatrust/trust-core';
import type { FieldMapping, KeyFieldConfig, ChangeDetectorOptions, AuditQueryOptions, AuditOperation, MatchingRule, ReconciliationOptions, RuleOperator } from '@datatrust/trust-core';
import { registry } from './connector-registry.js';

export interface ServerConfig {
  name: string;
  version: string;
}

/** Helper to create a text content item */
function textContent(text: string) {
  return { type: 'text' as const, text };
}

/** Helper to create a success result */
function success(data: unknown) {
  return {
    content: [textContent(JSON.stringify(data, null, 2))],
  };
}

/** Helper to create an error result */
function error(message: string) {
  return {
    content: [textContent(message)],
    isError: true,
  };
}

/** Format errors for MCP response */
function formatError(err: unknown) {
  const message =
    err instanceof ConnectorError
      ? err.toActionableMessage()
      : err instanceof TrustError
        ? err.toActionableMessage()
        : err instanceof Error
          ? err.message
          : String(err);
  return error(message);
}

/**
 * Validate and parse an ISO date string.
 * Returns the Date if valid, or throws an error with a helpful message.
 */
function parseISODate(dateStr: string, fieldName: string): Date {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new TrustError({
      code: 'INVALID_OPTIONS',
      message: `Invalid ${fieldName}: "${dateStr}" is not a valid ISO date`,
      suggestion: 'Use ISO format: "2024-01-15T18:00:00Z" or "2024-01-15"',
    });
  }
  return date;
}

/** Zod schema for ISO date strings */
const isoDateSchema = z.string().refine(
  (val) => !isNaN(new Date(val).getTime()),
  { message: 'Must be a valid ISO date (e.g., "2024-01-15T18:00:00Z")' }
);

/**
 * Create and configure the MCP server with all tools
 */
export async function createServer(config: ServerConfig): Promise<McpServer> {
  const server = new McpServer({
    name: config.name,
    version: config.version,
  });

  // Tool: list_connectors
  server.registerTool(
    'list_connectors',
    {
      description:
        'List all available data connectors. Returns connector IDs, names, types, and connection status.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const connectors = registry.list();
      return success({ connectors, count: connectors.length });
    }
  );

  // Tool: get_schema
  server.registerTool(
    'get_schema',
    {
      description:
        'Get the data schema for a connector. Returns field names, types, and whether they are required.',
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
        refresh: z.boolean().optional().describe('Force re-inference of schema'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);

        if (connector.state !== 'connected') {
          return error(
            `Connector '${args.connector_id}' is not connected (state: ${connector.state})`
          );
        }

        const schema = await connector.getSchema(args.refresh ?? false);
        return success({ connector_id: args.connector_id, schema });
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: read_records
  server.registerTool(
    'read_records',
    {
      description: `Read records from a data connector with optional filtering and pagination.

Filter syntax:
- where: Array of {field, op, value}. Operators: eq, neq, gt, lt, gte, lte, contains, in
- select: Array of field names to return
- orderBy: Array of {field, direction: "asc"|"desc"}
- offset/limit: Pagination

Example: {"where": [{"field": "amount", "op": "gt", "value": 1000}], "limit": 10}`,
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
        where: z
          .array(
            z.object({
              field: z.string(),
              op: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in']),
              value: z.unknown(),
            })
          )
          .optional()
          .describe('Filter conditions'),
        select: z.array(z.string()).optional().describe('Fields to return'),
        orderBy: z
          .array(
            z.object({
              field: z.string(),
              direction: z.enum(['asc', 'desc']),
            })
          )
          .optional()
          .describe('Sort order'),
        offset: z.number().optional().describe('Records to skip'),
        limit: z.number().optional().describe('Max records to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);

        if (connector.state !== 'connected') {
          return error(`Connector '${args.connector_id}' is not connected`);
        }

        const filter = {
          where: args.where?.map((w) => ({ ...w, value: w.value })),
          select: args.select,
          orderBy: args.orderBy,
          offset: args.offset,
          limit: args.limit,
        };

        const result = await connector.readRecords(filter);
        return success({ connector_id: args.connector_id, ...result });
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: write_records
  server.registerTool(
    'write_records',
    {
      description: `Write records to a data connector.

Modes: insert (new only), update (existing), upsert (both - default)

Example: {"connector_id": "invoices", "records": [{"customer": "ACME", "amount": 1500}]}`,
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
        records: z.array(z.record(z.unknown())).describe('Records to write'),
        mode: z
          .enum(['insert', 'update', 'upsert'])
          .optional()
          .describe('Write mode'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);

        if (connector.state !== 'connected') {
          return error(`Connector '${args.connector_id}' is not connected`);
        }

        if (connector.config.readonly) {
          return error(`Connector '${args.connector_id}' is read-only`);
        }

        const result = await connector.writeRecords(
          args.records,
          args.mode ?? 'upsert'
        );
        return success({ connector_id: args.connector_id, ...result });
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: validate_records
  server.registerTool(
    'validate_records',
    {
      description:
        'Validate records against a connector schema without writing. Use before write_records to check data.',
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
        records: z.array(z.record(z.unknown())).describe('Records to validate'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);

        if (connector.state !== 'connected') {
          return error(`Connector '${args.connector_id}' is not connected`);
        }

        const results = await connector.validateRecords(args.records);
        const validCount = results.filter((r) => r.valid).length;
        const invalidCount = results.filter((r) => !r.valid).length;

        return success({
          connector_id: args.connector_id,
          summary: { total: results.length, valid: validCount, invalid: invalidCount },
          results,
        });
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: compare_records
  server.registerTool(
    'compare_records',
    {
      description: `Compare records between two connectors to find inconsistencies.

Use this to detect data drift between systems, e.g.:
- Customer records in PostgreSQL vs HubSpot contacts
- Product data in MySQL vs Odoo inventory

Returns: Summary of matches, differences, and missing records with field-level details.`,
      inputSchema: {
        source_connector_id: z.string().describe('Source connector ID'),
        target_connector_id: z.string().describe('Target connector ID'),
        field_mappings: z
          .array(
            z.object({
              source: z.string().describe('Field name in source'),
              target: z.string().describe('Field name in target'),
              transform: z
                .enum(['lowercase', 'uppercase', 'trim', 'normalizeWhitespace'])
                .optional()
                .describe('Transform before comparing'),
            })
          )
          .describe('Field mappings for comparison'),
        key_fields: z
          .object({
            source: z.union([z.string(), z.array(z.string())]).describe('Key field(s) in source'),
            target: z.union([z.string(), z.array(z.string())]).describe('Key field(s) in target'),
          })
          .optional()
          .describe('Key fields for matching records (default: id)'),
        differences_only: z
          .boolean()
          .optional()
          .describe('Only return records with differences (default: true)'),
        max_records: z.number().optional().describe('Max records to compare'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const sourceConnector = registry.getOrThrow(args.source_connector_id);
        const targetConnector = registry.getOrThrow(args.target_connector_id);

        if (sourceConnector.state !== 'connected') {
          return error(`Source connector '${args.source_connector_id}' is not connected`);
        }
        if (targetConnector.state !== 'connected') {
          return error(`Target connector '${args.target_connector_id}' is not connected`);
        }

        const monitor = createConsistencyMonitor();
        const formatter = new MCPFormatter();

        const fieldMappings: FieldMapping[] = args.field_mappings.map((m) => ({
          source: m.source,
          target: m.target,
          transform: m.transform,
        }));

        const keyFields: KeyFieldConfig | undefined = args.key_fields
          ? {
              source: args.key_fields.source,
              target: args.key_fields.target,
            }
          : undefined;

        const report = await monitor.compare(sourceConnector, targetConnector, {
          mapping: {
            fields: fieldMappings,
            keyFields,
          },
          differencesOnly: args.differences_only ?? true,
          maxRecords: args.max_records,
        });

        const output = formatter.formatAsText(report);
        return { content: [textContent(output)] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: detect_changes
  server.registerTool(
    'detect_changes',
    {
      description: `Detect what changed in a connector since a specific time or snapshot.

Use cases:
- "What changed since yesterday 18:00?" → use timestamp_field + since
- "What changed since last sync?" → use snapshot_id

Modes:
1. Timestamp-based: Provide timestamp_field (e.g. "updated_at") and since (ISO date)
2. Snapshot-based: Provide snapshot_id from a previous create_snapshot call

Returns: Summary of added, modified, deleted records with details.`,
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
        timestamp_field: z
          .string()
          .optional()
          .describe('Field containing modification timestamp (e.g. "updated_at")'),
        since: isoDateSchema
          .optional()
          .describe('ISO date to compare from (e.g. "2024-01-15T18:00:00Z")'),
        snapshot_id: z.string().optional().describe('Snapshot ID to compare against'),
        key_field: z.string().optional().describe('Primary key field (default: "id")'),
        include_records: z
          .boolean()
          .optional()
          .describe('Include full record data in output (default: false)'),
        max_records: z.number().optional().describe('Max records to process'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);

        if (connector.state !== 'connected') {
          return error(`Connector '${args.connector_id}' is not connected`);
        }

        const changeDetector = createChangeDetector();
        const formatter = new MCPFormatter();

        const options: ChangeDetectorOptions = {
          timestampField: args.timestamp_field,
          since: args.since ? parseISODate(args.since, 'since') : undefined,
          snapshotId: args.snapshot_id,
          keyField: args.key_field,
          includeRecords: args.include_records,
          maxRecords: args.max_records,
        };

        const report = await changeDetector.detectChanges(connector, options);
        const output = formatter.formatChangeReport(report);
        return { content: [textContent(output)] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: create_snapshot
  server.registerTool(
    'create_snapshot',
    {
      description: `Create a snapshot of current connector data for later change detection.

Use this to establish a baseline, then use detect_changes with the snapshot_id to see what changed.

Example workflow:
1. create_snapshot(connector_id: "customers", snapshot_id: "sync-2024-01-15")
2. ... time passes, data changes ...
3. detect_changes(connector_id: "customers", snapshot_id: "sync-2024-01-15")`,
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
        snapshot_id: z.string().describe('Unique ID for this snapshot (e.g. "sync-2024-01-15")'),
        description: z.string().optional().describe('Optional description for the snapshot'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);

        if (connector.state !== 'connected') {
          return error(`Connector '${args.connector_id}' is not connected`);
        }

        const changeDetector = createChangeDetector();
        const snapshotInfo = await changeDetector.createSnapshot(
          connector,
          args.snapshot_id,
          { description: args.description }
        );

        return success({
          message: `Snapshot '${args.snapshot_id}' created successfully`,
          snapshot: {
            id: snapshotInfo.id,
            connectorId: snapshotInfo.connectorId,
            recordCount: snapshotInfo.recordCount,
            createdAt: snapshotInfo.createdAt.toISOString(),
          },
        });
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: list_snapshots
  server.registerTool(
    'list_snapshots',
    {
      description: 'List all available snapshots for a connector.',
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const changeDetector = createChangeDetector();
        const snapshots = await changeDetector.listSnapshots(args.connector_id);

        return success({
          connector_id: args.connector_id,
          snapshots: snapshots.map((s) => ({
            id: s.id,
            recordCount: s.recordCount,
            createdAt: s.createdAt.toISOString(),
          })),
          count: snapshots.length,
        });
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: delete_snapshot
  server.registerTool(
    'delete_snapshot',
    {
      description: 'Delete a snapshot.',
      inputSchema: {
        snapshot_id: z.string().describe('The ID of the snapshot to delete'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const changeDetector = createChangeDetector();
        await changeDetector.deleteSnapshot(args.snapshot_id);

        return success({
          message: `Snapshot '${args.snapshot_id}' deleted successfully`,
        });
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: query_audit_log
  server.registerTool(
    'query_audit_log',
    {
      description: `Query the audit log for past operations.

Use cases:
- "What was changed on customer X?" → use record_key
- "What did user Y change last week?" → use user + from/to
- "Show all deletes on invoices connector" → use connector_id + operation

Returns: List of audit entries with operation details, before/after values, and timestamps.`,
      inputSchema: {
        connector_id: z.string().optional().describe('Filter by connector ID'),
        operation: z
          .enum(['create', 'update', 'delete'])
          .optional()
          .describe('Filter by operation type'),
        record_key: z.string().optional().describe('Filter by record key'),
        user: z.string().optional().describe('Filter by user'),
        from: isoDateSchema.optional().describe('Filter from date (ISO format)'),
        to: isoDateSchema.optional().describe('Filter to date (ISO format)'),
        limit: z.number().optional().describe('Max entries to return (default: 100)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const auditLogger = createAuditLogger();
        const formatter = new MCPFormatter();

        const options: AuditQueryOptions = {
          connectorId: args.connector_id,
          operation: args.operation as AuditOperation | undefined,
          recordKey: args.record_key,
          user: args.user,
          from: args.from ? parseISODate(args.from, 'from') : undefined,
          to: args.to ? parseISODate(args.to, 'to') : undefined,
          limit: args.limit,
        };

        const report = await auditLogger.query(options);
        const output = formatter.formatAuditReport(report);
        return { content: [textContent(output)] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  // Tool: reconcile_records
  server.registerTool(
    'reconcile_records',
    {
      description: `Match records between two connectors using configurable rules.

Use cases:
- Match bank transactions with open invoices
- Match orders with shipments
- Match payments with receivables

Rule operators:
- equals: Exact match
- equals_tolerance: Numeric match within tolerance (e.g., ±0.01)
- contains: String contains (either direction)
- regex: Pattern match
- date_range: Date within ±N days

Returns: Matched pairs with confidence scores, unmatched records from both sides.`,
      inputSchema: {
        source_connector_id: z.string().describe('Source connector ID'),
        target_connector_id: z.string().describe('Target connector ID'),
        rules: z
          .array(
            z.object({
              name: z.string().describe('Rule name for identification'),
              source_field: z.string().describe('Field name in source records'),
              target_field: z.string().describe('Field name in target records'),
              operator: z
                .enum(['equals', 'equals_tolerance', 'contains', 'regex', 'date_range'])
                .describe('Comparison operator'),
              weight: z.number().min(1).max(100).describe('Weight for confidence (1-100)'),
              required: z.boolean().optional().describe('Must match for valid match'),
              tolerance: z.number().optional().describe('For equals_tolerance (e.g., 0.01)'),
              date_range_days: z.number().optional().describe('For date_range (e.g., 3 = ±3 days)'),
              case_sensitive: z.boolean().optional().describe('For string operators'),
            })
          )
          .describe('Matching rules to apply'),
        source_key_field: z.string().optional().describe('Key field in source (default: "id")'),
        target_key_field: z.string().optional().describe('Key field in target (default: "id")'),
        min_confidence: z.number().optional().describe('Minimum confidence for match (default: 50)'),
        max_records: z.number().optional().describe('Max records to process'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const sourceConnector = registry.getOrThrow(args.source_connector_id);
        const targetConnector = registry.getOrThrow(args.target_connector_id);

        if (sourceConnector.state !== 'connected') {
          return error(`Source connector '${args.source_connector_id}' is not connected`);
        }
        if (targetConnector.state !== 'connected') {
          return error(`Target connector '${args.target_connector_id}' is not connected`);
        }

        const reconciliationEngine = createReconciliationEngine();
        const formatter = new MCPFormatter();

        // Convert rules from input format
        const rules: MatchingRule[] = args.rules.map((r) => ({
          name: r.name,
          sourceField: r.source_field,
          targetField: r.target_field,
          operator: r.operator as RuleOperator,
          weight: r.weight,
          required: r.required,
          options: {
            tolerance: r.tolerance,
            dateRangeDays: r.date_range_days,
            caseSensitive: r.case_sensitive,
          },
        }));

        const options: ReconciliationOptions = {
          rules,
          sourceKeyField: args.source_key_field,
          targetKeyField: args.target_key_field,
          minConfidence: args.min_confidence,
          maxRecords: args.max_records,
        };

        const report = await reconciliationEngine.reconcile(
          sourceConnector,
          targetConnector,
          options
        );
        const output = formatter.formatReconciliationReport(report);
        return { content: [textContent(output)] };
      } catch (err) {
        return formatError(err);
      }
    }
  );

  return server;
}

/**
 * Run the server with stdio transport
 */
export async function runServer(config: ServerConfig): Promise<void> {
  const server = await createServer(config);
  const transport = new StdioServerTransport();

  // Handle shutdown gracefully
  process.on('SIGINT', async () => {
    await registry.disconnectAll();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await registry.disconnectAll();
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`MCP Server '${config.name}' v${config.version} started`);
  console.error(`Registered connectors: ${registry.listIds().join(', ') || 'none'}`);
}

export { registry } from './connector-registry.js';
