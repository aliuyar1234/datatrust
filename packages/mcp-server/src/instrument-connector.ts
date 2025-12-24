import type { IConnector, FilterOptions, ReadResult, Schema, ValidationResult, WriteResult } from '@datatrust/core';
import type { Logger } from './logger.js';
import { getTelemetry } from './telemetry.js';
import { metrics } from './metrics.js';

type ConnectorMethod =
  | 'connect'
  | 'disconnect'
  | 'getSchema'
  | 'readRecords'
  | 'writeRecords'
  | 'validateRecords'
  | 'testConnection';

function summarizeCall(method: ConnectorMethod, args: unknown[]): Record<string, unknown> {
  if (method === 'readRecords') {
    const options = (args[0] ?? {}) as Partial<FilterOptions>;
    return {
      where_count: Array.isArray(options.where) ? options.where.length : 0,
      select_count: Array.isArray(options.select) ? options.select.length : 0,
      limit: options.limit,
      offset: options.offset,
      order_by_count: Array.isArray(options.orderBy) ? options.orderBy.length : 0,
    };
  }
  if (method === 'writeRecords' || method === 'validateRecords') {
    const records = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
    return {
      record_count: records.length,
      mode: method === 'writeRecords' ? args[1] : undefined,
    };
  }
  if (method === 'getSchema') {
    return { refresh: args[0] };
  }
  return {};
}

export function instrumentConnector(connector: IConnector, logger: Logger): IConnector {
  const methods = new Set<ConnectorMethod>([
    'connect',
    'disconnect',
    'getSchema',
    'readRecords',
    'writeRecords',
    'validateRecords',
    'testConnection',
  ]);

  return new Proxy(connector as unknown as Record<string, unknown>, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (typeof prop !== 'string') return value;
      if (!methods.has(prop as ConnectorMethod)) return value;
      if (typeof value !== 'function') return value;

      const method = prop as ConnectorMethod;

      return async (...args: unknown[]) => {
        const ctx = getTelemetry();
        const traceId = ctx?.traceId;
        const tool = ctx?.tool;

        const connectorId = (connector as any).config?.id ?? 'unknown';
        const start = Date.now();
        try {
          const result = await value.apply(connector, args);
          const durationMs = Date.now() - start;
          metrics.incConnector(connectorId, method, 'success');
          metrics.observeConnectorDuration(connectorId, method, durationMs);
          logger.debug('Connector call succeeded', {
            traceId,
            tool,
            connector: connectorId,
            operation: method,
            durationMs,
            ...summarizeCall(method, args),
          });
          return result as unknown as ReadResult | WriteResult | ValidationResult[] | Schema | void | boolean;
        } catch (err) {
          const durationMs = Date.now() - start;
          metrics.incConnector(connectorId, method, 'error');
          metrics.observeConnectorDuration(connectorId, method, durationMs);
          logger.warn('Connector call failed', {
            traceId,
            tool,
            connector: connectorId,
            operation: method,
            durationMs,
            ...summarizeCall(method, args),
            error: err,
          });
          throw err;
        }
      };
    },
  }) as unknown as IConnector;
}
