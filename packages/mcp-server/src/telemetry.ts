import { AsyncLocalStorage } from 'node:async_hooks';

export type TelemetryContext = {
  traceId: string;
  tool: string;
  connectors: string[];
};

const storage = new AsyncLocalStorage<TelemetryContext>();

export function runWithTelemetry<T>(ctx: TelemetryContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getTelemetry(): TelemetryContext | undefined {
  return storage.getStore();
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

