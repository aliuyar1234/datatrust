import type { CircuitBreaker } from './circuit-breaker.js';

export type ConnectorErrorSummary = {
  name?: string;
  message: string;
  code?: string;
  at: string;
};

export type ConnectorHealth = {
  connectorId: string;
  inFlight: number;
  queueDepth: number;
  lastSuccessAt?: string;
  lastError?: ConnectorErrorSummary;
  circuitBreaker?: ReturnType<CircuitBreaker['getSnapshot']>;
};

type MutableHealth = {
  connectorId: string;
  inFlight: number;
  queueDepth: number;
  lastSuccessAt?: string;
  lastError?: ConnectorErrorSummary;
  breaker?: CircuitBreaker;
};

const healthByConnector = new Map<string, MutableHealth>();

function getOrCreate(connectorId: string): MutableHealth {
  const existing = healthByConnector.get(connectorId);
  if (existing) return existing;
  const created: MutableHealth = { connectorId, inFlight: 0, queueDepth: 0 };
  healthByConnector.set(connectorId, created);
  return created;
}

export function attachCircuitBreaker(connectorId: string, breaker: CircuitBreaker | null): void {
  const entry = getOrCreate(connectorId);
  entry.breaker = breaker ?? undefined;
}

export function recordConnectorConcurrency(connectorId: string, inFlight: number, queueDepth: number): void {
  const entry = getOrCreate(connectorId);
  entry.inFlight = inFlight;
  entry.queueDepth = queueDepth;
}

export function recordConnectorSuccess(connectorId: string): void {
  const entry = getOrCreate(connectorId);
  entry.lastSuccessAt = new Date().toISOString();
}

export function recordConnectorError(connectorId: string, err: unknown): void {
  const entry = getOrCreate(connectorId);
  const error = err instanceof Error ? err : new Error(String(err));
  const anyErr = err as { code?: unknown; name?: unknown };
  entry.lastError = {
    name: typeof anyErr?.name === 'string' ? anyErr.name : error.name,
    message: error.message,
    code: typeof anyErr?.code === 'string' ? anyErr.code : undefined,
    at: new Date().toISOString(),
  };
}

export function getConnectorHealth(connectorId: string): ConnectorHealth | null {
  const entry = healthByConnector.get(connectorId);
  if (!entry) return null;
  return {
    connectorId: entry.connectorId,
    inFlight: entry.inFlight,
    queueDepth: entry.queueDepth,
    lastSuccessAt: entry.lastSuccessAt,
    lastError: entry.lastError,
    circuitBreaker: entry.breaker?.getSnapshot(),
  };
}

export function listConnectorHealth(): ConnectorHealth[] {
  return Array.from(healthByConnector.values())
    .map((entry) => getConnectorHealth(entry.connectorId))
    .filter((v): v is ConnectorHealth => Boolean(v));
}

