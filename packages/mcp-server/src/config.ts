import { z } from 'zod';

export type TransportMode = 'stdio' | 'http';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type EnvExpansionOptions = {
  /**
   * If true, missing env vars leave placeholders unchanged instead of erroring.
   * Default: false (fail-fast).
   */
  allowMissing?: boolean;
};

function expandEnvInString(input: string, options?: EnvExpansionOptions): string {
  return input.replace(/\$\{([^}]+)\}/g, (_match, inner: string) => {
    const [rawName, rawDefault] = inner.split(':-', 2);
    const name = (rawName ?? '').trim();
    if (!name) return _match;

    const envValue = process.env[name];
    const hasValue = envValue !== undefined && envValue !== '';

    if (hasValue) return envValue!;

    if (rawDefault !== undefined) return rawDefault;

    if (options?.allowMissing) return _match;

    throw new ConfigError(`Missing required environment variable: ${name}`);
  });
}

export function expandEnvVars<T>(
  value: T,
  options?: EnvExpansionOptions
): T {
  if (typeof value === 'string') {
    return expandEnvInString(value, options) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvVars(v, options)) as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnvVars(v, options);
    }
    return out as T;
  }
  return value;
}

const retryConfigSchema = z
  .object({
    attempts: z.number().int().min(1).max(10).optional(),
    baseDelayMs: z.number().int().min(0).max(60_000).optional(),
    maxDelayMs: z.number().int().min(0).max(300_000).optional(),
    jitter: z.number().min(0).max(1).optional(),
  })
  .strict();

export type RetryConfig = z.infer<typeof retryConfigSchema>;

const circuitBreakerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    failureThreshold: z.number().int().min(1).max(100).optional(),
    openMs: z.number().int().min(1).max(600_000).optional(),
  })
  .strict();

export type CircuitBreakerConfig = z.infer<typeof circuitBreakerConfigSchema>;

const connectorRuntimeConfigSchema = z
  .object({
    maxConcurrency: z.number().int().min(1).max(1000).optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    retries: retryConfigSchema.optional(),
    circuitBreaker: circuitBreakerConfigSchema.optional(),
  })
  .strict();

export type ConnectorRuntimeConfig = z.infer<typeof connectorRuntimeConfigSchema>;

export const serverRuntimeConfigSchema = z
  .object({
    maxToolConcurrency: z.number().int().min(1).max(1000).optional(),
    toolTimeoutMs: z.number().int().min(1).max(600_000).optional(),
    connectorDefaults: connectorRuntimeConfigSchema.optional(),
  })
  .strict()
  .optional();

export type ServerRuntimeConfig = z.infer<typeof serverRuntimeConfigSchema>;

const connectorBase = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  readonly: z.boolean().optional(),
  runtime: connectorRuntimeConfigSchema.optional(),
});

const fileConnectorBase = connectorBase.extend({
  filePath: z.string().min(1),
  primaryKey: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  encoding: z.string().min(1).optional(),
});

const csvConnector = fileConnectorBase
  .extend({
    type: z.literal('csv'),
    delimiter: z.string().optional(),
    headers: z.boolean().optional(),
    quote: z.string().optional(),
    skipEmptyLines: z.boolean().optional(),
    sanitizeFormulas: z.boolean().optional(),
    formulaEscapePrefix: z.string().optional(),
  })
  .strict();

const jsonConnector = fileConnectorBase
  .extend({
    type: z.literal('json'),
    recordsPath: z.string().optional(),
    prettyPrint: z.boolean().optional(),
    indent: z.number().int().min(0).max(16).optional(),
  })
  .strict();

const excelConnector = fileConnectorBase
  .extend({
    type: z.literal('excel'),
    sheet: z.union([z.string().min(1), z.number().int().min(1)]).optional(),
    headers: z.boolean().optional(),
    startRow: z.number().int().min(1).optional(),
    startColumn: z.number().int().min(1).optional(),
  })
  .strict();

const odooConnector = connectorBase
  .extend({
    type: z.literal('odoo'),
    url: z.string().min(1),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    model: z.string().min(1),
    timeoutMs: z.number().int().min(1).max(300_000).optional(),
  })
  .strict();

const hubspotConnector = connectorBase
  .extend({
    type: z.literal('hubspot'),
    accessToken: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    objectType: z.enum(['contacts', 'companies', 'deals', 'tickets']),
    timeoutMs: z.number().int().min(1).max(300_000).optional(),
  })
  .strict();

const sslSchema = z.union([
  z.boolean(),
  z.object({ rejectUnauthorized: z.boolean().optional() }).strict(),
]);

const postgresConnector = connectorBase
  .extend({
    type: z.literal('postgresql'),
    connectionString: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    database: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    ssl: sslSchema.optional(),
    table: z.string().min(1),
    schema: z.string().min(1).optional(),
    primaryKey: z.string().min(1).optional(),
  })
  .strict();

const mysqlConnector = connectorBase
  .extend({
    type: z.literal('mysql'),
    uri: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    database: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    ssl: sslSchema.optional(),
    table: z.string().min(1),
    primaryKey: z.string().min(1).optional(),
  })
  .strict();

export const connectorEntrySchema = z.discriminatedUnion('type', [
  csvConnector,
  jsonConnector,
  excelConnector,
  odooConnector,
  hubspotConnector,
  postgresConnector,
  mysqlConnector,
]);

export type ConnectorEntry = z.infer<typeof connectorEntrySchema>;

export const policySchema = z
  .object({
    version: z.string().min(1).optional(),
    defaultAction: z.enum(['allow', 'deny']).optional(),
    allowTools: z.array(z.string().min(1)).optional(),
    denyTools: z.array(z.string().min(1)).optional(),
    allowConnectors: z.array(z.string().min(1)).optional(),
    denyConnectors: z.array(z.string().min(1)).optional(),
    rules: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            description: z.string().min(1).optional(),
            when: z
              .object({
                tool: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                connectorsAll: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                connectorsAny: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                selectFieldsAny: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                whereFieldsAny: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                recordFieldsAny: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                writeMode: z.enum(['insert', 'update', 'upsert']).optional(),
                subject: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                tenant: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                rolesAny: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
                scopesAny: z
                  .union([
                    z.string().min(1),
                    z.array(z.string().min(1)).min(1),
                    z.object({ regex: z.string().min(1) }).strict(),
                    z
                      .array(z.object({ regex: z.string().min(1) }).strict())
                      .min(1),
                  ])
                  .optional(),
              })
              .strict(),
            action: z.enum(['allow', 'deny']),
            requireApproval: z.boolean().optional(),
            maskFields: z.array(z.string().min(1)).optional(),
            reason: z.string().min(1).optional(),
          })
          .strict()
      )
      .optional(),
    masking: z
      .object({
        mode: z.enum(['redact']).optional(),
        replacement: z.string().optional(),
        fields: z.array(z.string().min(1)).optional(),
        perConnector: z.record(z.array(z.string().min(1))).optional(),
      })
      .optional(),
    writes: z
      .object({
        mode: z.enum(['allow', 'deny', 'require_approval']).optional(),
        approvalTokenEnv: z.string().min(1).optional(),
        approvalHook: z
          .object({
            url: z.string().min(1),
            method: z.enum(['POST']).optional(),
            timeoutMs: z.number().int().min(1).max(120_000).optional(),
            bearerTokenEnv: z.string().min(1).optional(),
            headers: z.record(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .optional(),
    audit: z
      .object({
        enabled: z.boolean().optional(),
        logDir: z.string().min(1).optional(),
        retentionDays: z.number().int().min(1).max(3650).optional(),
        maxFileBytes: z.number().int().min(1).max(1_000_000_000).optional(),
        remote: z
          .object({
            url: z.string().min(1),
            method: z.enum(['POST']).optional(),
            timeoutMs: z.number().int().min(1).max(120_000).optional(),
            bearerTokenEnv: z.string().min(1).optional(),
            headers: z.record(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .optional(),
    breakGlass: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export type PolicyConfig = z.infer<typeof policySchema>;

const httpRateLimitSchema = z
  .object({
    enabled: z.boolean().optional(),
    windowMs: z.number().int().min(1).max(300_000).optional(),
    maxRequests: z.number().int().min(1).max(10_000).optional(),
    key: z.enum(['ip', 'subject', 'ip+subject']).optional(),
  })
  .strict();

export type HttpRateLimitConfig = z.infer<typeof httpRateLimitSchema>;

const httpTlsSchema = z
  .object({
    enabled: z.boolean().optional(),
    keyFile: z.string().min(1).optional(),
    certFile: z.string().min(1).optional(),
    caFile: z.string().min(1).optional(),
    requestCert: z.boolean().optional(),
    rejectUnauthorized: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled) {
      if (!value.keyFile) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'server.http.tls.keyFile is required when tls.enabled=true',
          path: ['keyFile'],
        });
      }
      if (!value.certFile) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'server.http.tls.certFile is required when tls.enabled=true',
          path: ['certFile'],
        });
      }
    }
  });

export type HttpTlsConfig = z.infer<typeof httpTlsSchema>;

const jwtAuthSchema = z
  .object({
    issuer: z.string().min(1).optional(),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    algorithms: z.array(z.enum(['RS256', 'HS256'])).min(1).optional(),
    clockSkewSeconds: z.number().int().min(0).max(600).optional(),
    publicKeyFile: z.string().min(1).optional(),
    publicKeyEnv: z.string().min(1).optional(),
    hmacSecretEnv: z.string().min(1).optional(),
    requiredClaims: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    subjectClaim: z.string().min(1).optional(),
    tenantClaim: z.string().min(1).optional(),
    rolesClaim: z.string().min(1).optional(),
    scopesClaim: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const algorithms = value.algorithms ?? [];
    const usesRS = algorithms.length === 0 || algorithms.includes('RS256');
    const usesHS = algorithms.includes('HS256');

    if (usesRS && !value.publicKeyFile && !value.publicKeyEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'JWT RS256 requires publicKeyFile or publicKeyEnv (PEM)',
        path: ['publicKeyFile'],
      });
    }
    if (usesHS && !value.hmacSecretEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'JWT HS256 requires hmacSecretEnv',
        path: ['hmacSecretEnv'],
      });
    }
  });

export type JwtAuthConfig = z.infer<typeof jwtAuthSchema>;

const httpAuthSchema = z
  .object({
    mode: z.enum(['none', 'bearer', 'jwt', 'bearer_or_jwt']).optional(),
    bearerTokenEnv: z.string().min(1).optional(),
    jwt: jwtAuthSchema.optional(),
    breakGlassTokenEnv: z.string().min(1).optional(),
    breakGlassHeader: z.string().min(1).optional(),
  })
  .strict();

export type HttpAuthConfig = z.infer<typeof httpAuthSchema>;

const policyBundleSchema = z
  .object({
    path: z.string().min(1),
    signatureEnv: z.string().min(1),
    algorithm: z.enum(['hmac-sha256', 'rsa-sha256', 'ed25519']).optional(),
    publicKeyFile: z.string().min(1).optional(),
    publicKeyEnv: z.string().min(1).optional(),
    hmacSecretEnv: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const alg = value.algorithm ?? 'hmac-sha256';
    if (alg === 'hmac-sha256') {
      if (!value.hmacSecretEnv) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'policyBundle.hmacSecretEnv is required for hmac-sha256',
          path: ['hmacSecretEnv'],
        });
      }
    } else if (alg === 'rsa-sha256' || alg === 'ed25519') {
      if (!value.publicKeyFile && !value.publicKeyEnv) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `policyBundle requires publicKeyFile or publicKeyEnv for ${alg}`,
          path: ['publicKeyFile'],
        });
      }
    }
  })
  .optional();

export type PolicyBundleConfig = z.infer<typeof policyBundleSchema>;

const tenantConfigSchema = z
  .object({
    policy: policySchema,
  })
  .strict();

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export const serverSchema = z
  .object({
    name: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    transport: z.enum(['stdio', 'http']).optional(),
    http: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        path: z.string().min(1).optional(),
        metricsPath: z.string().min(1).optional(),
        healthPath: z.string().min(1).optional(),
        adminPath: z.string().min(1).optional(),
        maxRequestBytes: z.number().int().min(1).max(50_000_000).optional(),
        rateLimit: httpRateLimitSchema.optional(),
        bearerTokenEnv: z.string().min(1).optional(),
        tls: httpTlsSchema.optional(),
        auth: httpAuthSchema.optional(),
      })
      .strict()
      .optional(),
    policy: policySchema,
    policyBundle: policyBundleSchema,
    tenants: z.record(tenantConfigSchema).optional(),
    logging: z
      .object({
        format: z.enum(['text', 'json']).optional(),
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      })
      .strict()
      .optional(),
    runtime: serverRuntimeConfigSchema,
  })
  .strict()
  .optional();

export const configFileSchema = z
  .object({
    $schema: z.string().min(1).optional(),
    server: serverSchema,
    connectors: z.array(connectorEntrySchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (let i = 0; i < value.connectors.length; i++) {
      const entry = value.connectors[i];
      if (!entry) continue;
      const id = entry.id;
      if (ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate connector id: ${id}`,
          path: ['connectors', i, 'id'],
        });
      }
      ids.add(id);

      if (entry.type === 'hubspot') {
        const accessToken = entry.accessToken ?? entry.apiKey;
        if (!accessToken) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'Missing accessToken (or deprecated apiKey) for hubspot connector',
            path: ['connectors', i, 'accessToken'],
          });
        }
      }
    }
  });

export type ConfigFile = z.infer<typeof configFileSchema>;

export function formatZodError(err: z.ZodError): string {
  const issues = err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
  return `Invalid config.json:\n${issues}`;
}
