/**
 * MCP Server Implementation
 *
 * Generic MCP server that exposes connector tools.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { resolve as resolvePath } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ConnectorError } from '@datatrust/core';
import { createConsistencyMonitor, createChangeDetector, createAuditLogger, createReconciliationEngine, MCPFormatter, TrustError } from '@datatrust/trust-core';
import type { FieldMapping, KeyFieldConfig, ChangeDetectorOptions, AuditQueryOptions, AuditOperation, MatchingRule, ReconciliationOptions, RuleOperator } from '@datatrust/trust-core';
import { registry } from './connector-registry.js';
import { listConnectorHealth } from './connector-health.js';
import type {
  PolicyConfig,
  PolicyBundleConfig,
  ServerRuntimeConfig,
  TenantConfig,
  HttpTlsConfig,
  HttpAuthConfig,
  HttpRateLimitConfig,
} from './config.js';
import { Logger, createTraceId } from './logger.js';
import { PolicyAuditStore } from './policy-audit-store.js';
import {
  evaluatePolicy,
  getMaskReplacement,
  isFieldMasked,
  maskRecord,
  maskRecords,
} from './policy.js';
import { getTelemetry, getTraceId, runWithTelemetry } from './telemetry.js';
import { metrics } from './metrics.js';
import { Semaphore } from './semaphore.js';
import { withTimeout } from './timeout.js';
import { RateLimiter } from './rate-limiter.js';
import {
  buildHttpAuth,
  authenticateHttpRequest,
  HttpAuthError,
  type AuthContext,
} from './http-auth.js';

export interface ServerConfig {
  name: string;
  version: string;
  transport?: 'stdio' | 'http';
  http?: {
    host?: string;
    port?: number;
    path?: string;
    metricsPath?: string;
    healthPath?: string;
    adminPath?: string;
    maxRequestBytes?: number;
    rateLimit?: HttpRateLimitConfig;
    bearerTokenEnv?: string;
    tls?: HttpTlsConfig;
    auth?: HttpAuthConfig;
  };
  policy?: PolicyConfig;
  policyBundle?: PolicyBundleConfig;
  tenants?: Record<string, TenantConfig>;
  logging?: {
    format?: 'text' | 'json';
    level?: 'debug' | 'info' | 'warn' | 'error';
  };
  runtime?: ServerRuntimeConfig;
  logger?: Logger;
}

/** Helper to create a text content item */
function textContent(text: string) {
  return { type: 'text' as const, text };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Helper to create a success result */
function success(data: unknown, options?: { isError?: boolean }) {
  const traceId = getTraceId();
  const policyDecisionId = getTelemetry()?.policyDecisionId;
  const meta =
    traceId || policyDecisionId
      ? {
          ...(traceId ? { trace_id: traceId } : {}),
          ...(policyDecisionId ? { policy_decision_id: policyDecisionId } : {}),
        }
      : undefined;
  const payload =
    meta && isPlainObject(data)
      ? { ...meta, ...data }
      : meta
        ? { ...meta, data }
        : data;
  return {
    content: [textContent(JSON.stringify(payload, null, 2))],
    ...(options?.isError ? { isError: true } : {}),
  };
}

/** Helper to create an error result */
function error(message: string) {
  const traceId = getTraceId();
  const policyDecisionId = getTelemetry()?.policyDecisionId;
  const lines = [message];
  if (traceId) lines.push(`trace_id: ${traceId}`);
  if (policyDecisionId) lines.push(`policy_decision_id: ${policyDecisionId}`);
  const output = lines.join('\n');
  return {
    content: [textContent(output)],
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

function annotateTextOutput(text: string): string {
  const traceId = getTraceId();
  const policyDecisionId = getTelemetry()?.policyDecisionId;
  if (!traceId && !policyDecisionId) return text;

  const header = [
    traceId ? `trace_id: ${traceId}` : undefined,
    policyDecisionId ? `policy_decision_id: ${policyDecisionId}` : undefined,
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

  return `${header}\n\n${text}`;
}

const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const recordSchema = z
  .record(z.unknown())
  .refine((record) => !Array.isArray(record), {
    message: 'Record must be an object',
  })
  .superRefine((record, ctx) => {
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_RECORD_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsafe record key: ${key}`,
        });
      }
    }
  });

const SCHEMA_BACKED_CONNECTOR_TYPES = new Set([
  'postgresql',
  'mysql',
  'odoo',
  'hubspot',
]);

function findUnknownField(
  records: Array<Record<string, unknown>>,
  allowedFields: Set<string>
): { index: number; field: string } | null {
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    for (const field of Object.keys(record)) {
      if (!allowedFields.has(field)) {
        return { index: i, field };
      }
    }
  }
  return null;
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

  const logger =
    config.logger ??
    new Logger({
      level: config.logging?.level,
      format: config.logging?.format,
    });
  const policy = config.policy;
  const tenants = config.tenants;
  const policyAudit =
    policy?.audit?.enabled === true
      ? new PolicyAuditStore({
          baseDir: policy.audit.logDir ?? './.policy-audit',
          retentionDays: policy.audit.retentionDays,
          maxFileBytes: policy.audit.maxFileBytes,
          remote: policy.audit.remote
            ? {
                url: policy.audit.remote.url,
                bearerTokenEnv: policy.audit.remote.bearerTokenEnv,
                timeoutMs: policy.audit.remote.timeoutMs,
                headers: policy.audit.remote.headers,
              }
            : undefined,
        })
      : null;
  (server as any).__policyAudit = policyAudit;

  const toolSemaphore = new Semaphore(config.runtime?.maxToolConcurrency ?? 25);
  const toolTimeoutMs = config.runtime?.toolTimeoutMs ?? 120_000;
  const toolWaiting = new Map<string, number>();
  const toolInFlight = new Map<string, number>();

  const summarizeToolArgs = (tool: string, args: unknown): Record<string, unknown> => {
    const obj = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    if (tool === 'write_records') {
      const records = Array.isArray(obj['records']) ? (obj['records'] as unknown[]) : [];
      return {
        connector_id: obj['connector_id'],
        mode: obj['mode'],
        record_count: records.length,
      };
    }
    if (tool === 'read_records') {
      return {
        connector_id: obj['connector_id'],
        where_count: Array.isArray(obj['where']) ? (obj['where'] as unknown[]).length : 0,
        select_count: Array.isArray(obj['select']) ? (obj['select'] as unknown[]).length : 0,
        limit: obj['limit'],
        offset: obj['offset'],
      };
    }
    if (tool === 'compare_records') {
      return {
        source_connector_id: obj['source_connector_id'],
        target_connector_id: obj['target_connector_id'],
        mapping_count: Array.isArray(obj['field_mappings'])
          ? (obj['field_mappings'] as unknown[]).length
          : 0,
        max_records: obj['max_records'],
      };
    }
    if (tool === 'reconcile_records') {
      return {
        source_connector_id: obj['source_connector_id'],
        target_connector_id: obj['target_connector_id'],
        rule_count: Array.isArray(obj['rules']) ? (obj['rules'] as unknown[]).length : 0,
        min_confidence: obj['min_confidence'],
        max_records: obj['max_records'],
      };
    }
    if (tool === 'detect_changes') {
      return {
        connector_id: obj['connector_id'],
        snapshot_id: obj['snapshot_id'],
        since: obj['since'],
        include_records: obj['include_records'],
        max_records: obj['max_records'],
      };
    }
    if (tool === 'create_snapshot') {
      return {
        connector_id: obj['connector_id'],
        snapshot_id: obj['snapshot_id'],
      };
    }
    if (tool === 'query_audit_log') {
      return {
        connector_id: obj['connector_id'],
        operation: obj['operation'],
        record_key: obj['record_key'],
        user: obj['user'],
        from: obj['from'],
        to: obj['to'],
        limit: obj['limit'],
      };
    }
    return {};
  };

  const summarizePolicyInput = (tool: string, args: unknown) => {
    const obj = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};

    if (tool === 'write_records') {
      const records = Array.isArray(obj['records']) ? (obj['records'] as unknown[]) : [];
      const writeMode =
        obj['mode'] === 'insert' || obj['mode'] === 'update' || obj['mode'] === 'upsert'
          ? (obj['mode'] as 'insert' | 'update' | 'upsert')
          : 'upsert';

      const recordFields = new Set<string>();
      for (const record of records) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        for (const key of Object.keys(record as Record<string, unknown>)) {
          recordFields.add(key);
          if (recordFields.size >= 500) break;
        }
        if (recordFields.size >= 500) break;
      }

      return {
        writeMode,
        recordCount: records.length,
        recordFields: recordFields.size > 0 ? Array.from(recordFields) : undefined,
      };
    }

    if (tool === 'read_records') {
      const selectFields = Array.isArray(obj['select'])
        ? (obj['select'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined;
      const whereFields = Array.isArray(obj['where'])
        ? (obj['where'] as unknown[])
            .map((w) =>
              w && typeof w === 'object' && !Array.isArray(w) ? (w as { field?: unknown }).field : undefined
            )
            .filter((v): v is string => typeof v === 'string')
        : undefined;

      return { selectFields, whereFields };
    }

    if (tool === 'reconcile_records') {
      const recordFields = new Set<string>();
      const rules = Array.isArray(obj['rules']) ? (obj['rules'] as unknown[]) : [];
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
        const r = rule as { source_field?: unknown; target_field?: unknown };
        if (typeof r.source_field === 'string') recordFields.add(r.source_field);
        if (typeof r.target_field === 'string') recordFields.add(r.target_field);
        if (recordFields.size >= 200) break;
      }

      return {
        recordCount: typeof obj['max_records'] === 'number' ? obj['max_records'] : undefined,
        recordFields: recordFields.size > 0 ? Array.from(recordFields) : undefined,
      };
    }

    return undefined;
  };

  const registerTool = (
    toolName: string,
    definition: any,
    handler: (args: any) => Promise<any>,
    connectorsFromArgs: (args: any) => string[] = () => []
  ) => {
    server.registerTool(toolName, definition, async (args: any) => {
      const connectors = connectorsFromArgs(args);
      const parent = getTelemetry();
      const traceId = parent?.traceId ?? createTraceId();
      const decisionId = randomUUID();
      const telemetryCtx = {
        traceId,
        tool: toolName,
        connectors,
        policyDecisionId: decisionId,
        policyMaskFields: undefined as string[] | undefined,
        auth: parent?.auth,
        breakGlass: parent?.breakGlass,
        remoteIp: parent?.remoteIp,
      };

      return runWithTelemetry(telemetryCtx, async () => {
        const approvalToken =
          toolName === 'write_records'
            ? (args?.approval_token as string | undefined)
            : undefined;
        const decision = await evaluatePolicy(policy, {
          decision_id: decisionId,
          trace_id: traceId,
          tool: toolName,
          connectors,
          input: summarizePolicyInput(toolName, args),
          approvalToken,
          auth: telemetryCtx.auth,
          breakGlass: telemetryCtx.breakGlass,
          tenants,
        });
        telemetryCtx.policyMaskFields = decision.mask_fields;

        if (policyAudit) {
          try {
            await policyAudit.append({
              decision_id: decision.decision_id,
              timestamp: new Date(),
              trace_id: traceId,
              policy_version: decision.policy_version,
              tool: toolName,
              connectors,
              decision: decision.allowed ? 'allow' : 'deny',
              reason: decision.reason,
              rule_id: decision.rule_id,
              subject:
                telemetryCtx.auth?.kind === 'jwt'
                  ? telemetryCtx.auth.subject
                  : telemetryCtx.auth?.kind === 'bearer'
                    ? telemetryCtx.auth.subject
                    : undefined,
              tenant: telemetryCtx.auth?.kind === 'jwt' ? telemetryCtx.auth.tenantId : undefined,
              break_glass: decision.break_glass,
              request: summarizeToolArgs(toolName, args),
            });
          } catch (err) {
            logger.warn('Failed to write policy audit entry', {
              traceId,
              policyDecisionId: decision.decision_id,
              tool: toolName,
              error: err,
            });
          }
        }

        if (!decision.allowed) {
          logger.warn('Policy denied tool invocation', {
            traceId,
            policyDecisionId: decision.decision_id,
            tool: toolName,
            connectors,
            reason: decision.reason,
          });
          metrics.incTool(toolName, 'denied');
          return error(`Denied by policy: ${decision.reason}`);
        }

        const waited = (toolWaiting.get(toolName) ?? 0) + 1;
         toolWaiting.set(toolName, waited);
         metrics.setToolQueueDepth(toolName, waited);

         const queuedAt = Date.now();
         const release = await toolSemaphore.acquire();
         const waitMs = Date.now() - queuedAt;
         metrics.observeToolQueueWait(toolName, waitMs);

         const afterWait = (toolWaiting.get(toolName) ?? 1) - 1;
         toolWaiting.set(toolName, afterWait);
         metrics.setToolQueueDepth(toolName, afterWait);

         const inFlightNow = (toolInFlight.get(toolName) ?? 0) + 1;
         toolInFlight.set(toolName, inFlightNow);
         metrics.setToolInFlight(toolName, inFlightNow);

         const start = Date.now();
         try {
           const result = await withTimeout(
             handler(args),
             toolTimeoutMs,
             () => new Error(`Tool '${toolName}' timed out after ${toolTimeoutMs}ms`)
           );
           const durationMs = Date.now() - start;
           metrics.observeToolDuration(toolName, durationMs);
           metrics.incTool(toolName, result?.isError ? 'error' : 'success');
            logger.info('Tool invocation completed', {
            traceId,
              policyDecisionId: decision.decision_id,
              tool: toolName,
              connectors,
              durationMs,
              waitMs: waitMs > 0 ? waitMs : undefined,
              outcome: result?.isError ? 'error' : 'success',
            });
           return result;
         } catch (err) {
           const durationMs = Date.now() - start;
          metrics.observeToolDuration(toolName, durationMs);
          metrics.incTool(toolName, 'error');
           logger.error('Tool invocation failed', {
            traceId,
             policyDecisionId: decision.decision_id,
             tool: toolName,
             connectors,
             durationMs,
             waitMs: waitMs > 0 ? waitMs : undefined,
             error: err,
           });
           return formatError(err);
         } finally {
           release();
           const inFlight = (toolInFlight.get(toolName) ?? 1) - 1;
           toolInFlight.set(toolName, inFlight);
           metrics.setToolInFlight(toolName, inFlight);
        }
      }
      );
    });
  };

  // Tool: list_connectors
  registerTool(
    'list_connectors',
    {
      description:
        'List all available data connectors. Returns connector IDs, names, types, and connection status.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const connectors = registry.list();
      return success({ connectors, count: connectors.length });
    },
    () => []
  );

  // Tool: get_schema
  registerTool(
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
    },
    (args) => [args.connector_id]
  );

  // Tool: read_records
  registerTool(
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
        offset: z.number().int().min(0).optional().describe('Records to skip'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Max records to return (max: 10000)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);
        const extraMaskFields = getTelemetry()?.policyMaskFields;

        if (connector.state !== 'connected') {
          return error(`Connector '${args.connector_id}' is not connected`);
        }

        const filter = {
          where: args.where?.map(
            (w: { field: string; op: string; value: unknown }) => ({
              ...w,
              value: w.value,
            })
          ),
          select: args.select,
          orderBy: args.orderBy,
          offset: args.offset,
          limit: args.limit,
        };

        const result = await connector.readRecords(filter);
        const records = Array.isArray(result.records)
          ? maskRecords(
              result.records as Array<Record<string, unknown>>,
              args.connector_id,
              policy,
              extraMaskFields
            )
          : result.records;
        return success({ connector_id: args.connector_id, ...result, records });
      } catch (err) {
        return formatError(err);
      }
    },
    (args) => [args.connector_id]
  );

  // Tool: write_records
  registerTool(
    'write_records',
    {
      description: `Write records to a data connector.

Modes: insert (new only), update (existing), upsert (both - default)

Example: {"connector_id": "invoices", "records": [{"customer": "ACME", "amount": 1500}]}`,
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
        records: z
          .array(recordSchema)
          .min(1)
          .max(1000)
          .describe('Records to write (max: 1000)'),
        approval_token: z
          .string()
          .optional()
          .describe(
            'Optional write approval token. If policy.writes.mode=require_approval, this must match the server env var configured by policy.writes.approvalTokenEnv (default: DATATRUST_WRITE_TOKEN).'
          ),
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
        const extraMaskFields = getTelemetry()?.policyMaskFields;

        if (connector.state !== 'connected') {
          return error(`Connector '${args.connector_id}' is not connected`);
        }

        if (connector.config.readonly) {
          return error(`Connector '${args.connector_id}' is read-only`);
        }

        if (SCHEMA_BACKED_CONNECTOR_TYPES.has(connector.config.type)) {
          const schema = await connector.getSchema(false);
          const allowedFields = new Set(schema.fields.map((f) => f.name));
          const unknown = findUnknownField(args.records, allowedFields);
          if (unknown) {
            return error(
              `Unknown field '${unknown.field}' in record index ${unknown.index}. Call get_schema to see valid fields.`
            );
          }
        }

        const validation = await connector.validateRecords(args.records);
        const invalid = validation
          .map((result, index) => ({ ...result, index }))
          .filter((result) => !result.valid);
        if (invalid.length > 0) {
          return success(
            {
              message: 'Validation failed; no records were written.',
              invalidCount: invalid.length,
              invalid: invalid.slice(0, 20),
            },
            { isError: true }
          );
        }

        const result = await connector.writeRecords(
          args.records,
          args.mode ?? 'upsert'
        );
        return success({ connector_id: args.connector_id, ...result });
      } catch (err) {
        return formatError(err);
      }
    },
    (args) => [args.connector_id]
  );

  // Tool: validate_records
  registerTool(
    'validate_records',
    {
      description:
        'Validate records against a connector schema without writing. Use before write_records to check data.',
      inputSchema: {
        connector_id: z.string().describe('The ID of the connector'),
        records: z
          .array(recordSchema)
          .min(1)
          .max(1000)
          .describe('Records to validate (max: 1000)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);
        const extraMaskFields = getTelemetry()?.policyMaskFields;

        if (connector.state !== 'connected') {
          return error(`Connector '${args.connector_id}' is not connected`);
        }

        if (SCHEMA_BACKED_CONNECTOR_TYPES.has(connector.config.type)) {
          const schema = await connector.getSchema(false);
          const allowedFields = new Set(schema.fields.map((f) => f.name));
          const unknown = findUnknownField(args.records, allowedFields);
          if (unknown) {
            return error(
              `Unknown field '${unknown.field}' in record index ${unknown.index}. Call get_schema to see valid fields.`
            );
          }
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
    },
    (args) => [args.connector_id]
  );

  // Tool: compare_records
  registerTool(
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
        max_records: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Max records to compare (max: 10000)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const sourceConnector = registry.getOrThrow(args.source_connector_id);
        const targetConnector = registry.getOrThrow(args.target_connector_id);
        const extraMaskFields = getTelemetry()?.policyMaskFields;

        if (sourceConnector.state !== 'connected') {
          return error(`Source connector '${args.source_connector_id}' is not connected`);
        }
        if (targetConnector.state !== 'connected') {
          return error(`Target connector '${args.target_connector_id}' is not connected`);
        }

        const monitor = createConsistencyMonitor();
        const formatter = new MCPFormatter();

        const fieldMappings: FieldMapping[] = args.field_mappings.map(
          (
            m: {
              source: string;
              target: string;
              transform?: 'lowercase' | 'uppercase' | 'trim' | 'normalizeWhitespace';
            }
          ) => ({
          source: m.source,
          target: m.target,
          transform: m.transform,
        })
        );

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

        const replacement = getMaskReplacement(policy);
        const maskedReport = {
          ...report,
          records: report.records.map((r) => ({
            ...r,
            sourceRecord: r.sourceRecord
              ? maskRecord(
                  r.sourceRecord as Record<string, unknown>,
                  args.source_connector_id,
                  policy,
                  extraMaskFields
                )
              : undefined,
            targetRecord: r.targetRecord
              ? maskRecord(
                  r.targetRecord as Record<string, unknown>,
                  args.target_connector_id,
                  policy,
                  extraMaskFields
                )
              : undefined,
            differences: r.differences?.map((d) =>
              isFieldMasked(d.field, args.source_connector_id, policy, extraMaskFields)
                ? { ...d, sourceValue: replacement, targetValue: replacement }
                : d
            ),
          })),
        };

        const output = formatter.formatAsText(maskedReport);
        return { content: [textContent(annotateTextOutput(output))] };
      } catch (err) {
        return formatError(err);
      }
    },
    (args) => [args.source_connector_id, args.target_connector_id]
  );

  // Tool: detect_changes
  registerTool(
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
        max_records: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Max records to process (max: 10000)'),
        blocking_mode: z
          .enum(['auto', 'configured', 'off'])
          .optional()
          .describe('Optional blocking mode to reduce candidate comparisons'),
        blocking_source_field: z
          .string()
          .optional()
          .describe('For blocking_mode=configured: source field used for blocking'),
        blocking_target_field: z
          .string()
          .optional()
          .describe('For blocking_mode=configured: target field used for blocking'),
        blocking_algorithm: z
          .enum(['exact', 'prefix', 'cologne_phonetic', 'soundex'])
          .optional()
          .describe('For blocking_mode=configured: blocking algorithm'),
        blocking_prefix_length: z
          .number()
          .int()
          .min(1)
          .max(32)
          .optional()
          .describe('For blocking_algorithm=prefix: prefix length (default: 4)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const connector = registry.getOrThrow(args.connector_id);
        const extraMaskFields = getTelemetry()?.policyMaskFields;

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
        const maskedReport = {
          ...report,
          changes: report.changes.map((c) => ({
            ...c,
            record: c.record
              ? maskRecord(
                  c.record as Record<string, unknown>,
                  args.connector_id,
                  policy,
                  extraMaskFields
                )
              : undefined,
            previousRecord: c.previousRecord
              ? maskRecord(
                  c.previousRecord as Record<string, unknown>,
                  args.connector_id,
                  policy,
                  extraMaskFields
                )
              : undefined,
          })),
        };
        const output = formatter.formatChangeReport(maskedReport);        
        return { content: [textContent(annotateTextOutput(output))] };
      } catch (err) {
        return formatError(err);
      }
    },
    (args) => [args.connector_id]
  );

  // Tool: create_snapshot
  registerTool(
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
    },
    (args) => [args.connector_id]
  );

  // Tool: list_snapshots
  registerTool(
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
    },
    (args) => [args.connector_id]
  );

  // Tool: delete_snapshot
  registerTool(
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
    },
    () => []
  );

  // Tool: query_audit_log
  registerTool(
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
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Max entries to return (default: 100, max: 1000)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const auditLogger = createAuditLogger();
        const formatter = new MCPFormatter();
        const extraMaskFields = getTelemetry()?.policyMaskFields;

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
        const maskedReport = {
          ...report,
          entries: report.entries.map((e) => ({
            ...e,
            before: e.before
              ? maskRecord(
                  e.before as Record<string, unknown>,
                  e.connectorId,
                  policy,
                  extraMaskFields
                )
              : undefined,
            after: e.after
              ? maskRecord(
                  e.after as Record<string, unknown>,
                  e.connectorId,
                  policy,
                  extraMaskFields
                )
              : undefined,
          })),
        };
        const output = formatter.formatAuditReport(maskedReport);
        return { content: [textContent(annotateTextOutput(output))] };
      } catch (err) {
        return formatError(err);
      }
    },
    (args) => (args.connector_id ? [args.connector_id] : [])
  );

  // Tool: reconcile_records
  registerTool(
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
- regex: Pattern match (safe by default; set unsafe_regex=true for raw regex)
- similarity: Fuzzy string match (e.g., names, references)
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
                .enum([
                  'equals',
                  'equals_tolerance',
                  'contains',
                  'regex',
                  'similarity',
                  'date_range',
                ])
                .describe('Comparison operator'),
              weight: z.number().min(1).max(100).describe('Weight for confidence (1-100)'),
              required: z.boolean().optional().describe('Must match for valid match'),
              tolerance: z
                .number()
                .min(0)
                .optional()
                .describe('For equals_tolerance (e.g., 0.01)'),
              date_range_days: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('For date_range (e.g., 3 = ±3 days)'),
              case_sensitive: z.boolean().optional().describe('For string operators'),
              unsafe_regex: z
                .boolean()
                .optional()
                .describe('For regex: allow raw patterns (unsafe; default: false)'),
              similarity_algorithm: z
                .enum([
                  'levenshtein',
                  'jaro',
                  'jaro_winkler',
                  'dice_sorensen',
                  'jaccard',
                  'cologne_phonetic',
                  'soundex',
                ])
                .optional()
                .describe('For similarity: algorithm (default: jaro_winkler)'),
              similarity_threshold: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe('For similarity: threshold 0-1 (default: 0.85)'),
              ngram_size: z
                .number()
                .int()
                .min(1)
                .max(5)
                .optional()
                .describe('For similarity dice/jaccard: n-gram size (default: 2)'),
              prefix_scale: z
                .number()
                .min(0)
                .max(0.25)
                .optional()
                .describe('For similarity jaro_winkler: prefix scale (default: 0.1)'),
            })
          )
          .describe('Matching rules to apply'),
        source_key_field: z.string().optional().describe('Key field in source (default: "id")'),
        target_key_field: z.string().optional().describe('Key field in target (default: "id")'),
        min_confidence: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Minimum confidence for match (default: 50)'),
        max_records: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Max records to process (max: 10000)'),
        blocking_mode: z
          .enum(['auto', 'configured', 'off'])
          .optional()
          .describe(
            'Optional blocking mode to reduce candidate comparisons (default: auto when possible)'
          ),
        blocking_source_field: z
          .string()
          .optional()
          .describe('For blocking_mode=configured: source field used for blocking'),
        blocking_target_field: z
          .string()
          .optional()
          .describe('For blocking_mode=configured: target field used for blocking'),
        blocking_algorithm: z
          .enum(['exact', 'prefix', 'cologne_phonetic', 'soundex'])
          .optional()
          .describe('For blocking_mode=configured: blocking algorithm (default: exact)'),
        blocking_prefix_length: z
          .number()
          .int()
          .min(1)
          .max(32)
          .optional()
          .describe('For blocking_algorithm=prefix: prefix length (default: 4)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const sourceConnector = registry.getOrThrow(args.source_connector_id);
        const targetConnector = registry.getOrThrow(args.target_connector_id);
        const extraMaskFields = getTelemetry()?.policyMaskFields;

        if (sourceConnector.state !== 'connected') {
          return error(`Source connector '${args.source_connector_id}' is not connected`);
        }
        if (targetConnector.state !== 'connected') {
          return error(`Target connector '${args.target_connector_id}' is not connected`);
        }

        const reconciliationEngine = createReconciliationEngine();
        const formatter = new MCPFormatter();

        // Convert rules from input format
        const rules: MatchingRule[] = args.rules.map(
          (
            r: {
              name: string;
              source_field: string;
              target_field: string;
              operator: string;
              weight: number;
              required?: boolean;
              tolerance?: number;
              date_range_days?: number;
              case_sensitive?: boolean;
              unsafe_regex?: boolean;
              similarity_algorithm?: string;
              similarity_threshold?: number;
              ngram_size?: number;
              prefix_scale?: number;
            }
          ) => ({
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
            unsafeRegex: r.unsafe_regex,
            similarityAlgorithm: r.similarity_algorithm,
            similarityThreshold: r.similarity_threshold,
            ngramSize: r.ngram_size,
            prefixScale: r.prefix_scale,
          },
        })
        );

        const options: ReconciliationOptions = {
          rules,
          sourceKeyField: args.source_key_field,
          targetKeyField: args.target_key_field,
          minConfidence: args.min_confidence,
          maxRecords: args.max_records,
          blocking:
            args.blocking_mode ||
            args.blocking_source_field ||
            args.blocking_target_field ||
            args.blocking_algorithm ||
            args.blocking_prefix_length
              ? {
                  mode: args.blocking_mode,
                  sourceField: args.blocking_source_field,
                  targetField: args.blocking_target_field,
                  algorithm: args.blocking_algorithm,
                  prefixLength: args.blocking_prefix_length,
                }
              : undefined,
        };

        const report = await reconciliationEngine.reconcile(
          sourceConnector,
          targetConnector,
          options
        );
        const maskedReport = {
          ...report,
          matched: report.matched.map((m) => ({
            ...m,
            sourceRecord: maskRecord(
              m.sourceRecord as Record<string, unknown>,
              args.source_connector_id,
              policy,
              extraMaskFields
            ),
            targetRecord: maskRecord(
              m.targetRecord as Record<string, unknown>,
              args.target_connector_id,
              policy,
              extraMaskFields
            ),
          })),
          unmatchedSource: report.unmatchedSource.map((u) => ({
            ...u,
            record: maskRecord(
              u.record as Record<string, unknown>,
              args.source_connector_id,
              policy,
              extraMaskFields
            ),
          })),
          unmatchedTarget: report.unmatchedTarget.map((u) => ({
            ...u,
            record: maskRecord(
              u.record as Record<string, unknown>,
              args.target_connector_id,
              policy,
              extraMaskFields
            ),
          })),
        };
        const output = formatter.formatReconciliationReport(maskedReport);
        return { content: [textContent(annotateTextOutput(output))] };
      } catch (err) {
        return formatError(err);
      }
    },
    (args) => [args.source_connector_id, args.target_connector_id]
  );

  return server;
}

/**
 * Run the server with configured transport
 */
export async function runServer(config: ServerConfig): Promise<void> {
  const logger =
    config.logger ??
    new Logger({
      level: config.logging?.level,
      format: config.logging?.format,
    });
  const server = await createServer({ ...config, logger });

  const mode = config.transport ?? 'stdio';

  const shutdown = async (signal: string, httpServer?: import('node:http').Server) => {
    try {
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      await registry.disconnectAll();
      await server.close();
      logger.info('Shutdown complete', { signal });
    } finally {
      process.exit(0);
    }
  };

  if (mode === 'http') {
    const host = config.http?.host ?? '127.0.0.1';
    const port = config.http?.port ?? 3333;
    const mcpPath = config.http?.path ?? '/mcp';
    const metricsPath = config.http?.metricsPath ?? '/metrics';
    const healthPath = config.http?.healthPath ?? '/healthz';
    const adminPath = config.http?.adminPath ?? '/admin/status';
    const maxRequestBytes = config.http?.maxRequestBytes ?? 5_000_000;
    const rateLimiter = RateLimiter.fromConfig(config.http?.rateLimit);

    const authModeInferred: NonNullable<HttpAuthConfig['mode']> =
      config.http?.auth?.mode ??
      (config.http?.auth?.jwt
        ? (config.http?.auth?.bearerTokenEnv ?? config.http?.bearerTokenEnv)
          ? 'bearer_or_jwt'
          : 'jwt'
        : (config.http?.auth?.bearerTokenEnv ?? config.http?.bearerTokenEnv)
          ? 'bearer'
          : 'none');

    const httpAuth = await buildHttpAuth(
      config.http?.auth ? { ...config.http.auth, mode: authModeInferred } : { mode: authModeInferred },
      config.http?.bearerTokenEnv
    );

    const tls = config.http?.tls;
    const useTls = tls?.enabled === true;
    const scheme = useTls ? 'https' : 'http';
    const tlsOptions =
      useTls
        ? {
            key: await readFile(resolvePath(process.cwd(), tls.keyFile!)),
            cert: await readFile(resolvePath(process.cwd(), tls.certFile!)),
            ca: tls.caFile ? await readFile(resolvePath(process.cwd(), tls.caFile)) : undefined,
            requestCert: tls.requestCert ?? false,
            rejectUnauthorized: tls.rejectUnauthorized ?? true,
          }
        : undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);

    const requestHandler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      const sendText = (status: number, body: string, headers?: Record<string, string>) => {
        res.writeHead(status, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          ...(headers ?? {}),
        });
        res.end(body);
      };

      const url = new URL(req.url ?? '/', `${scheme}://${host}:${port}`);

      // Basic request size limit (best-effort via Content-Length header).
      const contentLength = Number(req.headers['content-length'] ?? '0');
      if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
        sendText(413, 'Request entity too large');
        return;
      }

      if (req.method === 'GET' && url.pathname === healthPath) {
        sendText(200, 'ok');
        return;
      }

      // mTLS: require valid client certificate when enabled.
      if (useTls && tls?.requestCert) {
        const socket = req.socket as any;
        if (socket.authorized !== true) {
          sendText(401, 'Unauthorized');
          return;
        }
      }

      let authContext: AuthContext;
      let breakGlass = false;
      try {
        const result = authenticateHttpRequest(req, httpAuth);
        authContext = result.auth;
        breakGlass = result.breakGlass;
      } catch (err) {
        if (err instanceof HttpAuthError) {
          sendText(err.status, err.status === 401 ? 'Unauthorized' : 'Forbidden');
          return;
        }
        sendText(401, 'Unauthorized');
        return;
      }

      // Optional rate limiting (best-effort, in-memory).
      if (rateLimiter) {
        rateLimiter.prune();
        const ip = req.socket.remoteAddress ?? 'unknown';
        const subject =
          authContext.kind === 'jwt'
            ? authContext.subject
            : authContext.kind === 'bearer'
              ? authContext.subject
              : undefined;
        const keyMode = config.http?.rateLimit?.key ?? 'ip';
        const key =
          keyMode === 'subject'
            ? subject ?? ip
            : keyMode === 'ip+subject'
              ? `${ip}|${subject ?? ''}`
              : ip;
        const result = rateLimiter.check(key);
        res.setHeader('X-RateLimit-Limit', String(result.limit));
        res.setHeader('X-RateLimit-Remaining', String(result.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.floor(result.resetAt / 1000)));
        if (!result.allowed) {
          const retryAfter = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000));
          res.setHeader('Retry-After', String(retryAfter));
          sendText(429, 'Too Many Requests');
          return;
        }
      }

      if (req.method === 'GET' && url.pathname === metricsPath) {
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(metrics.render());
        return;
      }

      if (req.method === 'GET' && url.pathname === adminPath) {
        const policyAuditStore = (server as any).__policyAudit as
          | PolicyAuditStore
          | null
          | undefined;
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(
          JSON.stringify(
            {
              name: config.name,
              version: config.version,
              transport: 'http',
              now: new Date().toISOString(),
              connectors: registry.list(),
              connector_health: listConnectorHealth(),
              audit_sink: policyAuditStore
                ? { enabled: true, status: policyAuditStore.getStatus() }
                : { enabled: false },
              policy: config.policy
                ? {
                    version: config.policy.version,
                    defaultAction: config.policy.defaultAction,
                    breakGlassEnabled: config.policy.breakGlass?.enabled,
                  }
                : undefined,
              runtime: {
                maxToolConcurrency: config.runtime?.maxToolConcurrency ?? 25,
                toolTimeoutMs: config.runtime?.toolTimeoutMs ?? 120_000,
                maxRequestBytes,
                rateLimit: config.http?.rateLimit?.enabled ? config.http.rateLimit : { enabled: false },
                tls: useTls
                  ? { enabled: true, requestCert: tls?.requestCert ?? false }
                  : { enabled: false },
              },
              auth: { kind: authContext.kind },
              break_glass: breakGlass,
            },
            null,
            2
          )
        );
        return;
      }

      if (url.pathname === mcpPath) {
        const traceparent = req.headers['traceparent'];
        const parsedTraceId =
          typeof traceparent === 'string'
            ? traceparent.match(/^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i)?.[1]
            : undefined;
        const traceId = parsedTraceId ?? createTraceId();
        const remoteIp = req.socket.remoteAddress ?? 'unknown';
        await runWithTelemetry(
          {
            traceId,
            tool: '__http__',
            connectors: [],
            auth: authContext,
            breakGlass,
            remoteIp,
          },
          async () => await transport.handleRequest(req as any, res as any)
        );
        return;
      }

      sendText(404, 'Not found');
    };

    const httpServer = useTls
      ? createHttpsServer(tlsOptions as any, requestHandler)
      : createHttpServer(requestHandler);

    process.on('SIGINT', () => void shutdown('SIGINT', httpServer));
    process.on('SIGTERM', () => void shutdown('SIGTERM', httpServer));

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => resolve());
    });

    logger.info('MCP server started', {
      name: config.name,
      version: config.version,
      transport: 'http',
      url: `${scheme}://${host}:${port}${mcpPath}`,
      metrics: `${scheme}://${host}:${port}${metricsPath}`,
      health: `${scheme}://${host}:${port}${healthPath}`,
      admin: `${scheme}://${host}:${port}${adminPath}`,
      connectors: registry.listIds(),
    });

    return;
  }

  const transport = new StdioServerTransport();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.connect(transport);

  logger.info('MCP server started', {
    name: config.name,
    version: config.version,
    transport: 'stdio',
    connectors: registry.listIds(),
  });
}

export { registry } from './connector-registry.js';
