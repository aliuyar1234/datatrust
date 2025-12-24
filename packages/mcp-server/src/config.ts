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

const connectorBase = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  readonly: z.boolean().optional(),
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
    defaultAction: z.enum(['allow', 'deny']).optional(),
    allowTools: z.array(z.string().min(1)).optional(),
    denyTools: z.array(z.string().min(1)).optional(),
    allowConnectors: z.array(z.string().min(1)).optional(),
    denyConnectors: z.array(z.string().min(1)).optional(),
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
      })
      .optional(),
    audit: z
      .object({
        enabled: z.boolean().optional(),
        logDir: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict()
  .optional();

export type PolicyConfig = z.infer<typeof policySchema>;

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
        bearerTokenEnv: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    policy: policySchema,
    logging: z
      .object({
        format: z.enum(['text', 'json']).optional(),
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      })
      .strict()
      .optional(),
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
