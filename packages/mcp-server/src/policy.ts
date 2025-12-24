import type { PolicyConfig } from './config.js';

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
};

export type PolicyContext = {
  tool: string;
  connectors: string[];
  approvalToken?: string;
};

function matches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  return pattern === value;
}

function matchesAny(patterns: string[] | undefined, value: string): boolean {
  if (!patterns?.length) return false;
  return patterns.some((p) => matches(p, value));
}

function listDecision(
  subject: string,
  value: string,
  allowList: string[] | undefined,
  denyList: string[] | undefined,
  defaultAction: 'allow' | 'deny'
): PolicyDecision {
  if (matchesAny(denyList, value) || matchesAny(denyList, '*')) {
    return { allowed: false, reason: `${subject} '${value}' denied by policy` };
  }

  if (allowList?.length) {
    if (matchesAny(allowList, value) || matchesAny(allowList, '*')) {
      return { allowed: true, reason: `${subject} '${value}' allowed by allowlist` };
    }
    return { allowed: false, reason: `${subject} '${value}' not in allowlist` };
  }

  return {
    allowed: defaultAction === 'allow',
    reason: `${subject} '${value}' default policy: ${defaultAction}`,
  };
}

export function evaluatePolicy(
  policy: PolicyConfig | undefined,
  ctx: PolicyContext
): PolicyDecision {
  const defaultAction = policy?.defaultAction ?? 'allow';

  const toolDecision = listDecision(
    'Tool',
    ctx.tool,
    policy?.allowTools,
    policy?.denyTools,
    defaultAction
  );
  if (!toolDecision.allowed) return toolDecision;

  for (const connectorId of ctx.connectors) {
    const connectorDecision = listDecision(
      'Connector',
      connectorId,
      policy?.allowConnectors,
      policy?.denyConnectors,
      defaultAction
    );
    if (!connectorDecision.allowed) return connectorDecision;
  }

  if (ctx.tool === 'write_records') {
    const mode = policy?.writes?.mode ?? 'allow';
    if (mode === 'deny') {
      return { allowed: false, reason: 'Writes denied by policy' };
    }

    if (mode === 'require_approval') {
      const envVar = policy?.writes?.approvalTokenEnv ?? 'DATATRUST_WRITE_TOKEN';
      const expected = process.env[envVar];
      if (!expected) {
        return {
          allowed: false,
          reason: `Writes require approval but ${envVar} is not set on the server`,
        };
      }
      if (!ctx.approvalToken) {
        return {
          allowed: false,
          reason:
            'Writes require approval. Provide approval_token and ensure the server has the expected token set.',
        };
      }
      if (ctx.approvalToken !== expected) {
        return { allowed: false, reason: 'Invalid approval_token' };
      }
    }
  }

  return { allowed: true, reason: 'Allowed by policy' };
}

function normalizeFieldName(field: string): string {
  return field.trim().toLowerCase();
}

function buildMaskSet(policy: PolicyConfig | undefined, connectorId: string): Set<string> {
  const fields = new Set<string>();
  for (const f of policy?.masking?.fields ?? []) fields.add(normalizeFieldName(f));
  const per = policy?.masking?.perConnector?.[connectorId] ?? [];
  for (const f of per) fields.add(normalizeFieldName(f));
  return fields;
}

export function getMaskReplacement(policy: PolicyConfig | undefined): string {
  return policy?.masking?.replacement ?? '[REDACTED]';
}

export function isFieldMasked(
  fieldName: string,
  connectorId: string,
  policy: PolicyConfig | undefined
): boolean {
  const maskSet = buildMaskSet(policy, connectorId);
  if (!maskSet.size) return false;
  return maskSet.has(normalizeFieldName(fieldName));
}

export function maskRecord(
  record: Record<string, unknown>,
  connectorId: string,
  policy: PolicyConfig | undefined
): Record<string, unknown> {
  const maskSet = buildMaskSet(policy, connectorId);
  if (!maskSet.size) return record;

  const replacement = getMaskReplacement(policy);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(record)) {
    if (maskSet.has(normalizeFieldName(key))) {
      out[key] = replacement;
    } else {
      out[key] = record[key];
    }
  }
  return out;
}

export function maskRecords(
  records: Array<Record<string, unknown>>,
  connectorId: string,
  policy: PolicyConfig | undefined
): Array<Record<string, unknown>> {
  const maskSet = buildMaskSet(policy, connectorId);
  if (!maskSet.size) return records;
  return records.map((r) => maskRecord(r, connectorId, policy));
}
