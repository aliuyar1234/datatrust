import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from './http-auth.js';

export type TelemetryContext = {
  traceId: string;
  tool: string;
  connectors: string[];
  policyDecisionId?: string;
  policyMaskFields?: string[];
  auth?: AuthContext;
  breakGlass?: boolean;
  remoteIp?: string;
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

export function getPolicyDecisionId(): string | undefined {
  return storage.getStore()?.policyDecisionId;
}

export function getPolicyMaskFields(): string[] | undefined {
  return storage.getStore()?.policyMaskFields;
}

export function getAuthContext(): AuthContext | undefined {
  return storage.getStore()?.auth;
}

export function getBreakGlass(): boolean | undefined {
  return storage.getStore()?.breakGlass;
}

