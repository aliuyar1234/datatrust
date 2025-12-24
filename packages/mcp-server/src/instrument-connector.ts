import type {
  IConnector,
  FilterOptions,
  ReadResult,
  Schema,
  ValidationResult,
  WriteResult,
} from '@datatrust/core';
import { ConnectorError } from '@datatrust/core';
import type { Logger } from './logger.js';
import { getTelemetry } from './telemetry.js';
import { metrics } from './metrics.js';
import { Semaphore } from './semaphore.js';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.js';
import { withRetries, type RetryConfig } from './retry.js';
import { withTimeout } from './timeout.js';
import {
  attachCircuitBreaker,
  recordConnectorConcurrency,
  recordConnectorError,
  recordConnectorSuccess,
} from './connector-health.js';

export type ConnectorRuntimeConfig = {
  maxConcurrency?: number;
  timeoutMs?: number;
  retries?: RetryConfig;
  circuitBreaker?: CircuitBreakerConfig;
};

export type InstrumentConnectorOptions = {
  runtime?: ConnectorRuntimeConfig;
  defaults?: ConnectorRuntimeConfig;
};

type ConnectorMethod =
  | 'connect'
  | 'disconnect'
  | 'getSchema'
  | 'readRecords'
  | 'writeRecords'
  | 'validateRecords'
  | 'testConnection';

function isRetryableConnectorError(err: unknown): boolean {
  if (err instanceof ConnectorError) {
    return (
      err.code === 'TIMEOUT' ||
      err.code === 'CONNECTION_FAILED' ||
      err.code === 'RATE_LIMITED'
    );
  }

  const code = (err as { code?: unknown })?.code;
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN'
  );
}

function canRetryMethod(method: ConnectorMethod): boolean {
  return (
    method === 'connect' ||
    method === 'testConnection' ||
    method === 'getSchema' ||
    method === 'readRecords' ||
    method === 'validateRecords'
  );
}

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

export function instrumentConnector(
  connector: IConnector,
  logger: Logger,
  options?: InstrumentConnectorOptions
): IConnector {
  const methods = new Set<ConnectorMethod>([
    'connect',
    'disconnect',
    'getSchema',
    'readRecords',
    'writeRecords',
    'validateRecords',
    'testConnection',
  ]);

  const connectorId = (connector as any).config?.id ?? 'unknown';
  const maxConcurrency =
    options?.runtime?.maxConcurrency ?? options?.defaults?.maxConcurrency ?? 10;
  const timeoutMs =
    options?.runtime?.timeoutMs ?? options?.defaults?.timeoutMs ?? 60_000;
  const retries = options?.runtime?.retries ?? options?.defaults?.retries;
  const breakerConfig =
    options?.runtime?.circuitBreaker ?? options?.defaults?.circuitBreaker;

  const semaphore = new Semaphore(maxConcurrency);
  const breaker = CircuitBreaker.fromConfig(breakerConfig);
  if (breaker) attachCircuitBreaker(connectorId, breaker);

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

        const breakerNow = Date.now();
        if (breaker && !breaker.canRequest(breakerNow)) {
          const snap = breaker.getSnapshot(breakerNow);
          const err = new ConnectorError({
            code: 'CONNECTION_FAILED',
            message: `Circuit breaker is open for connector '${connectorId}'`,
            connectorId,
            suggestion: `Wait and retry later (breaker state: ${snap.mode}).`,
            context: { circuitBreaker: snap, operation: method },
          });
          recordConnectorError(connectorId, err);
          throw err;
        }
        breaker?.onStart();

        const queuedAt = Date.now();
        const release = await semaphore.acquire();
        const waitMs = Date.now() - queuedAt;
        metrics.observeConnectorQueueWait(connectorId, method, waitMs);
        metrics.setConnectorInFlight(connectorId, semaphore.inFlight);
        metrics.setConnectorQueueDepth(connectorId, semaphore.queueDepth);
        recordConnectorConcurrency(connectorId, semaphore.inFlight, semaphore.queueDepth);

        const start = Date.now();
        try {
          const result = await withRetries(
            async () =>
              await withTimeout(
                Promise.resolve(value.apply(connector, args)),
                timeoutMs,
                () =>
                  new ConnectorError({
                    code: 'TIMEOUT',
                    message: `Connector call '${method}' timed out after ${timeoutMs}ms`,
                    connectorId,
                    suggestion:
                      'Increase connector.runtime.timeoutMs or server runtime defaults.',
                    context: { operation: method, timeoutMs },
                  })
              ),
            canRetryMethod(method) ? retries : undefined,
            isRetryableConnectorError
          );

          const durationMs = Date.now() - start;
          breaker?.onSuccess();
          recordConnectorSuccess(connectorId);
          metrics.incConnector(connectorId, method, 'success');
          metrics.observeConnectorDuration(connectorId, method, durationMs);
          logger.debug('Connector call succeeded', {
            traceId,
            tool,
            connector: connectorId,
            operation: method,
            durationMs,
            waitMs: waitMs > 0 ? waitMs : undefined,
            ...summarizeCall(method, args),
          });
          return result as unknown as
            | ReadResult
            | WriteResult
            | ValidationResult[]
            | Schema
            | void
            | boolean;
        } catch (err) {
          const durationMs = Date.now() - start;
          breaker?.onFailure();
          recordConnectorError(connectorId, err);
          metrics.incConnector(connectorId, method, 'error');
          metrics.observeConnectorDuration(connectorId, method, durationMs);
          logger.warn('Connector call failed', {
            traceId,
            tool,
            connector: connectorId,
            operation: method,
            durationMs,
            waitMs: waitMs > 0 ? waitMs : undefined,
            ...summarizeCall(method, args),
            error: err,
          });
          throw err;
        } finally {
          release();
          metrics.setConnectorInFlight(connectorId, semaphore.inFlight);
          metrics.setConnectorQueueDepth(connectorId, semaphore.queueDepth);
          recordConnectorConcurrency(connectorId, semaphore.inFlight, semaphore.queueDepth);
        }
      };
    },
  }) as unknown as IConnector;
}
