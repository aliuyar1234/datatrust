import type { PolicyConfig, TenantConfig } from './config.js';
import type { AuthContext } from './http-auth.js';

type Matcher = string | { regex: string };

function normalizeMatcherList(value: unknown): Matcher[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value as Matcher[];
  return [value as Matcher];
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${withWildcards}$`);
}

function matchesMatcher(matcher: Matcher, value: string): boolean {
  if (typeof matcher === 'string') {
    if (matcher === '*') return true;
    if (matcher.includes('*')) return globToRegExp(matcher).test(value);
    return matcher === value;
  }

  try {
    return new RegExp(matcher.regex).test(value);
  } catch {
    return false;
  }
}

function matchesAnyMatcher(matchers: Matcher[] | undefined, value: string): boolean {
  if (!matchers?.length) return false;
  return matchers.some((m) => matchesMatcher(m, value));
}

function matchesAnyValue(matchers: Matcher[] | undefined, values: string[] | undefined): boolean {
  if (!matchers?.length) return false;
  if (!values?.length) return false;
  return values.some((v) => matchesAnyMatcher(matchers, v));
}

function matchesAllValues(matchers: Matcher[] | undefined, values: string[]): boolean {
  if (!matchers?.length) return false;
  return values.every((v) => matchesAnyMatcher(matchers, v));
}

type IdentityContext = {
  subject?: string;
  tenant?: string;
  roles?: string[];
  scopes?: string[];
};

function getIdentity(auth?: AuthContext): IdentityContext {
  if (!auth || auth.kind === 'none') return {};
  if (auth.kind === 'bearer') return { subject: auth.subject };
  return {
    subject: auth.subject,
    tenant: auth.tenantId,
    roles: auth.roles,
    scopes: auth.scopes,
  };
}

export type PolicyInputSummary = {
  writeMode?: 'insert' | 'update' | 'upsert';
  recordCount?: number;
  recordFields?: string[];
  selectFields?: string[];
  whereFields?: string[];
};

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  decision_id: string;
  policy_version?: string;
  rule_id?: string;
  break_glass?: boolean;
  mask_fields?: string[];
  write_approved_by?: 'token' | 'hook';
};

export type PolicyContext = {
  decision_id: string;
  trace_id?: string;
  tool: string;
  connectors: string[];
  input?: PolicyInputSummary;
  approvalToken?: string;
  auth?: AuthContext;
  breakGlass?: boolean;
  tenants?: Record<string, TenantConfig>;
};

function mergePolicy(base: PolicyConfig | undefined, tenant: PolicyConfig | undefined): PolicyConfig | undefined {
  if (!tenant) return base;
  if (!base) return tenant;

  return {
    ...base,
    ...tenant,
    masking: tenant.masking ?? base.masking,
    writes: tenant.writes ?? base.writes,
    audit: tenant.audit ?? base.audit,
    rules: tenant.rules ?? base.rules,
  };
}

function resolveEffectivePolicy(policy: PolicyConfig | undefined, ctx: PolicyContext): PolicyConfig | undefined {
  const tenantId = getIdentity(ctx.auth).tenant;
  if (!tenantId) return policy;
  const tenantPolicy = ctx.tenants?.[tenantId]?.policy;
  return mergePolicy(policy, tenantPolicy);
}

function listDecision(
  subject: string,
  value: string,
  allowList: string[] | undefined,
  denyList: string[] | undefined,
  defaultAction: 'allow' | 'deny'
): { allowed: boolean; reason: string } {
  if (denyList?.includes(value) || denyList?.includes('*')) {
    return { allowed: false, reason: `${subject} '${value}' denied by policy` };
  }

  if (allowList?.length) {
    if (allowList.includes(value) || allowList.includes('*')) {
      return { allowed: true, reason: `${subject} '${value}' allowed by allowlist` };
    }
    return { allowed: false, reason: `${subject} '${value}' not in allowlist` };
  }

  return {
    allowed: defaultAction === 'allow',
    reason: `${subject} '${value}' default policy: ${defaultAction}`,
  };
}

function ruleMatches(rule: any, ctx: PolicyContext, identity: IdentityContext): boolean {
  const when = rule?.when;
  if (!when || typeof when !== 'object') return false;

  const toolMatchers = normalizeMatcherList(when.tool);
  if (toolMatchers && !matchesAnyMatcher(toolMatchers, ctx.tool)) return false;

  const connectorsAll = normalizeMatcherList(when.connectorsAll);
  if (connectorsAll && !matchesAllValues(connectorsAll, ctx.connectors)) return false;

  const connectorsAny = normalizeMatcherList(when.connectorsAny);
  if (connectorsAny && !matchesAnyValue(connectorsAny, ctx.connectors)) return false;

  if (when.writeMode && ctx.input?.writeMode && when.writeMode !== ctx.input.writeMode) return false;
  if (when.writeMode && !ctx.input?.writeMode) return false;

  const selectAny = normalizeMatcherList(when.selectFieldsAny);
  if (selectAny && !matchesAnyValue(selectAny, ctx.input?.selectFields)) return false;

  const whereAny = normalizeMatcherList(when.whereFieldsAny);
  if (whereAny && !matchesAnyValue(whereAny, ctx.input?.whereFields)) return false;

  const recordAny = normalizeMatcherList(when.recordFieldsAny);
  if (recordAny && !matchesAnyValue(recordAny, ctx.input?.recordFields)) return false;

  const subjectMatchers = normalizeMatcherList(when.subject);
  if (subjectMatchers && (!identity.subject || !matchesAnyMatcher(subjectMatchers, identity.subject))) {
    return false;
  }

  const tenantMatchers = normalizeMatcherList(when.tenant);
  if (tenantMatchers && (!identity.tenant || !matchesAnyMatcher(tenantMatchers, identity.tenant))) {
    return false;
  }

  const rolesAny = normalizeMatcherList(when.rolesAny);
  if (rolesAny && !matchesAnyValue(rolesAny, identity.roles)) return false;

  const scopesAny = normalizeMatcherList(when.scopesAny);
  if (scopesAny && !matchesAnyValue(scopesAny, identity.scopes)) return false;

  return true;
}

async function callApprovalHook(
  hook: NonNullable<NonNullable<PolicyConfig>['writes']>['approvalHook'],
  payload: Record<string, unknown>
): Promise<{ allowed: boolean; reason?: string }> {
  if (!hook) return { allowed: false, reason: 'Missing approval hook' };

  const controller = new AbortController();
  const timeoutMs = hook.timeoutMs ?? 10_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(hook.headers ?? {}),
    };
    if (hook.bearerTokenEnv) {
      const token = process.env[hook.bearerTokenEnv];
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { allowed: false, reason: `Approval hook returned HTTP ${res.status}` };
    }

    const json = (await res.json().catch(() => null)) as any;
    if (!json || typeof json !== 'object') return { allowed: false, reason: 'Invalid approval hook response' };
    return {
      allowed: Boolean(json.allowed),
      reason: typeof json.reason === 'string' ? json.reason : undefined,
    };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      return { allowed: false, reason: 'Approval hook timed out' };
    }
    return { allowed: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function evaluatePolicy(
  policy: PolicyConfig | undefined,
  ctx: PolicyContext
): Promise<PolicyDecision> {
  const effectivePolicy = resolveEffectivePolicy(policy, ctx);
  const identity = getIdentity(ctx.auth);

  const defaultAction = effectivePolicy?.defaultAction ?? 'allow';
  const policyVersion = effectivePolicy?.version;

  if (ctx.breakGlass && effectivePolicy?.breakGlass?.enabled) {
    return {
      allowed: true,
      reason: 'Break-glass override',
      decision_id: ctx.decision_id,
      policy_version: policyVersion,
      break_glass: true,
    };
  }

  const toolDecision = listDecision(
    'Tool',
    ctx.tool,
    effectivePolicy?.allowTools,
    effectivePolicy?.denyTools,
    defaultAction
  );
  if (!toolDecision.allowed) {
    return {
      allowed: false,
      reason: toolDecision.reason,
      decision_id: ctx.decision_id,
      policy_version: policyVersion,
    };
  }

  for (const connectorId of ctx.connectors) {
    const connectorDecision = listDecision(
      'Connector',
      connectorId,
      effectivePolicy?.allowConnectors,
      effectivePolicy?.denyConnectors,
      defaultAction
    );
    if (!connectorDecision.allowed) {
      return {
        allowed: false,
        reason: connectorDecision.reason,
        decision_id: ctx.decision_id,
        policy_version: policyVersion,
      };
    }
  }

  let matchedRule: any | undefined;
  let maskFields: string[] | undefined;
  let requireApproval = false;

  for (const rule of effectivePolicy?.rules ?? []) {
    if (!ruleMatches(rule, ctx, identity)) continue;
    matchedRule = rule;
    maskFields = Array.isArray(rule.maskFields) ? rule.maskFields : undefined;
    requireApproval = Boolean(rule.requireApproval);
    if (rule.action === 'deny') {
      return {
        allowed: false,
        reason: rule.reason ?? `Denied by rule${rule.id ? `: ${rule.id}` : ''}`,
        decision_id: ctx.decision_id,
        policy_version: policyVersion,
        rule_id: rule.id,
      };
    }
    break;
  }

  // Write approval policy
  if (ctx.tool === 'write_records') {
    const mode = effectivePolicy?.writes?.mode ?? 'allow';
    if (mode === 'deny') {
      return {
        allowed: false,
        reason: 'Writes denied by policy',
        decision_id: ctx.decision_id,
        policy_version: policyVersion,
        rule_id: matchedRule?.id,
      };
    }

    const needsApproval = mode === 'require_approval' || requireApproval;
    if (needsApproval) {
      const envVar = effectivePolicy?.writes?.approvalTokenEnv ?? 'DATATRUST_WRITE_TOKEN';
      const expected = process.env[envVar];
      if (expected && ctx.approvalToken && ctx.approvalToken === expected) {
        return {
          allowed: true,
          reason: matchedRule?.reason ?? 'Write approved by token',
          decision_id: ctx.decision_id,
          policy_version: policyVersion,
          rule_id: matchedRule?.id,
          mask_fields: maskFields,
          write_approved_by: 'token',
        };
      }

      const hook = effectivePolicy?.writes?.approvalHook;
      if (hook) {
        const hookResult = await callApprovalHook(hook, {
          decision_id: ctx.decision_id,
          trace_id: ctx.trace_id,
          tool: ctx.tool,
          connectors: ctx.connectors,
          write_mode: ctx.input?.writeMode,
          record_count: ctx.input?.recordCount,
          subject: identity.subject,
          tenant: identity.tenant,
        });
        if (hookResult.allowed) {
          return {
            allowed: true,
            reason: hookResult.reason ?? matchedRule?.reason ?? 'Write approved by hook',
            decision_id: ctx.decision_id,
            policy_version: policyVersion,
            rule_id: matchedRule?.id,
            mask_fields: maskFields,
            write_approved_by: 'hook',
          };
        }
        return {
          allowed: false,
          reason: hookResult.reason ?? 'Write approval hook denied the request',
          decision_id: ctx.decision_id,
          policy_version: policyVersion,
          rule_id: matchedRule?.id,
        };
      }

      return {
        allowed: false,
        reason:
          'Writes require approval. Provide approval_token or configure writes.approvalHook.',
        decision_id: ctx.decision_id,
        policy_version: policyVersion,
        rule_id: matchedRule?.id,
      };
    }
  }

  return {
    allowed: true,
    reason: matchedRule?.reason ?? 'Allowed by policy',
    decision_id: ctx.decision_id,
    policy_version: policyVersion,
    rule_id: matchedRule?.id,
    mask_fields: maskFields,
  };
}

function normalizeFieldName(field: string): string {
  return field.trim().toLowerCase();
}

function buildMaskSet(
  policy: PolicyConfig | undefined,
  connectorId: string,
  extraMaskFields?: string[]
): Set<string> {
  const fields = new Set<string>();
  for (const f of policy?.masking?.fields ?? []) fields.add(normalizeFieldName(f));
  for (const f of extraMaskFields ?? []) fields.add(normalizeFieldName(f));
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
  policy: PolicyConfig | undefined,
  extraMaskFields?: string[]
): boolean {
  const maskSet = buildMaskSet(policy, connectorId, extraMaskFields);
  if (!maskSet.size) return false;
  return maskSet.has(normalizeFieldName(fieldName));
}

export function maskRecord(
  record: Record<string, unknown>,
  connectorId: string,
  policy: PolicyConfig | undefined,
  extraMaskFields?: string[]
): Record<string, unknown> {
  const maskSet = buildMaskSet(policy, connectorId, extraMaskFields);
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
  policy: PolicyConfig | undefined,
  extraMaskFields?: string[]
): Array<Record<string, unknown>> {
  const maskSet = buildMaskSet(policy, connectorId, extraMaskFields);
  if (!maskSet.size) return records;
  return records.map((r) => maskRecord(r, connectorId, policy, extraMaskFields));
}
