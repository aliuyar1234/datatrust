#!/usr/bin/env node
/**
 * CLI entry point for the MCP server
 *
 * Usage:
 *   datatrust --config ./config.json
 */

import { createHmac, timingSafeEqual, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runServer, registry } from './server.js';
import {
  configFileSchema,
  expandEnvVars,
  policySchema,
  formatZodError,
  type ConfigFile,
  type ConnectorEntry,
  type PolicyBundleConfig,
  type PolicyConfig,
} from './config.js';
import { Logger } from './logger.js';
import { instrumentConnector } from './instrument-connector.js';
import {
  createCsvConnector,
  createJsonConnector,
  createExcelConnector,
} from '@datatrust/connector-file';
import { createOdooConnector, createHubSpotConnector } from '@datatrust/connector-api';
import { createPostgresConnector, createMySQLConnector } from '@datatrust/connector-db';

function stripUtf8BomBytes(input: Uint8Array): Uint8Array {
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return input.slice(3);
  }
  return input;
}

function decodeBinaryFromEnv(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.startsWith('hex:')) return Buffer.from(trimmed.slice(4), 'hex');
  if (trimmed.startsWith('base64:')) return Buffer.from(trimmed.slice(7), 'base64');
  return Buffer.from(trimmed, 'base64');
}

function decodeHmacSecret(raw: string): string | Buffer {
  const trimmed = raw.trim();
  if (trimmed.startsWith('hex:')) return Buffer.from(trimmed.slice(4), 'hex');
  if (trimmed.startsWith('base64:')) return Buffer.from(trimmed.slice(7), 'base64');
  return trimmed;
}

function normalizePem(value: string): string {
  // Common pattern when embedding PEMs in env vars.
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

function formatZodIssues(
  label: string,
  err: { issues: Array<{ path: Array<string | number>; message: string }> }
): string {
  const issues = err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
  return `${label}:\n${issues}`;
}

async function loadPublicKey(config: NonNullable<PolicyBundleConfig>): Promise<string> {
  if (config.publicKeyEnv) {
    const raw = process.env[config.publicKeyEnv];
    if (!raw) throw new Error(`Missing required environment variable: ${config.publicKeyEnv}`);
    return normalizePem(raw);
  }

  if (config.publicKeyFile) {
    return await readFile(resolve(process.cwd(), config.publicKeyFile), 'utf-8');
  }

  throw new Error('policyBundle requires publicKeyFile or publicKeyEnv');
}

async function loadSignedPolicyBundle(config: NonNullable<PolicyBundleConfig>): Promise<PolicyConfig> {
  const rawSignature = process.env[config.signatureEnv];
  if (!rawSignature) {
    throw new Error(`Missing required environment variable: ${config.signatureEnv}`);
  }
  const signature = decodeBinaryFromEnv(rawSignature);

  const absolutePath = resolve(process.cwd(), config.path);
  const fileBytes = stripUtf8BomBytes(await readFile(absolutePath));

  const alg = config.algorithm ?? 'hmac-sha256';
  if (alg === 'hmac-sha256') {
    const secretEnv = config.hmacSecretEnv;
    if (!secretEnv) throw new Error('policyBundle.hmacSecretEnv is required for hmac-sha256');
    const rawSecret = process.env[secretEnv];
    if (!rawSecret) throw new Error(`Missing required environment variable: ${secretEnv}`);
    const secret = decodeHmacSecret(rawSecret);
    const digest = createHmac('sha256', secret).update(fileBytes).digest();
    if (signature.length !== digest.length || !timingSafeEqual(signature, digest)) {
      throw new Error('Invalid policy bundle signature (hmac-sha256)');
    }
  } else if (alg === 'rsa-sha256') {
    const publicKey = await loadPublicKey(config);
    const ok = verify('RSA-SHA256', fileBytes, publicKey, signature);
    if (!ok) throw new Error('Invalid policy bundle signature (rsa-sha256)');
  } else if (alg === 'ed25519') {
    const publicKey = await loadPublicKey(config);
    const ok = verify(null, fileBytes, publicKey, signature);
    if (!ok) throw new Error('Invalid policy bundle signature (ed25519)');
  } else {
    const exhaustive: never = alg;
    throw new Error(`Unsupported policy bundle algorithm: ${exhaustive}`);
  }

  const parsed = JSON.parse(Buffer.from(fileBytes).toString('utf-8')) as unknown;
  const expanded = expandEnvVars(parsed);
  const result = policySchema.safeParse(expanded);
  if (!result.success) {
    throw new Error(formatZodIssues('Invalid policy bundle', result.error));
  }
  return result.data;
}

async function loadConfig(configPath: string): Promise<ConfigFile> {
  const absolutePath = resolve(process.cwd(), configPath);
  const content = await readFile(absolutePath, 'utf-8');
  // Handle UTF-8 BOM (common on Windows) to avoid JSON.parse failures.
  const sanitized = content.replace(/^\uFEFF/, '');
  const parsed = JSON.parse(sanitized) as unknown;
  const expanded = expandEnvVars(parsed);
  const result = configFileSchema.safeParse(expanded);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }

  const config = result.data;
  const policyBundle = config.server?.policyBundle;
  if (policyBundle) {
    const policy = await loadSignedPolicyBundle(policyBundle);
    config.server = { ...(config.server ?? {}), policy };
  }

  return config;
}

function createConnector(entry: ConnectorEntry) {
  switch (entry.type) {
    case 'csv':
      return createCsvConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        filePath: resolve(process.cwd(), entry.filePath),
        primaryKey: entry.primaryKey,
        encoding: entry.encoding as BufferEncoding | undefined,
        delimiter: entry.delimiter,
        headers: entry.headers,
        sanitizeFormulas: entry.sanitizeFormulas,
        formulaEscapePrefix: entry.formulaEscapePrefix,
      });

    case 'json':
      return createJsonConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        filePath: resolve(process.cwd(), entry.filePath),
        primaryKey: entry.primaryKey,
        encoding: entry.encoding as BufferEncoding | undefined,
        recordsPath: entry.recordsPath,
        prettyPrint: entry.prettyPrint,
        indent: entry.indent,
      });

    case 'excel':
      return createExcelConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        filePath: resolve(process.cwd(), entry.filePath),
        primaryKey: entry.primaryKey,
        encoding: entry.encoding as BufferEncoding | undefined,
        sheet: entry.sheet,
        headers: entry.headers,
        startRow: entry.startRow,
        startColumn: entry.startColumn,
      });

    case 'odoo':
      return createOdooConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        url: entry.url,
        database: entry.database,
        username: entry.username,
        password: entry.password,
        model: entry.model,
        timeoutMs: entry.timeoutMs,
      });

    case 'hubspot':
      // config validation guarantees that at least one of these is present.
      // HubSpot connector itself expects a Private App access token.
      const accessToken = entry.accessToken ?? entry.apiKey;
      if (!accessToken) {
        throw new Error(
          'HubSpot connector requires accessToken (or deprecated apiKey)'
        );
      }
      return createHubSpotConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        accessToken,
        objectType: entry.objectType,
        timeoutMs: entry.timeoutMs,
      });

    case 'postgresql':
      return createPostgresConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        connectionString: entry.connectionString,
        host: entry.host,
        port: entry.port,
        database: entry.database,
        user: entry.user,
        password: entry.password,
        ssl: entry.ssl,
        table: entry.table,
        schema: entry.schema,
        primaryKey: entry.primaryKey,
      });

    case 'mysql':
      return createMySQLConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        uri: entry.uri,
        host: entry.host,
        port: entry.port,
        database: entry.database,
        user: entry.user,
        password: entry.password,
        ssl: entry.ssl,
        table: entry.table,
        primaryKey: entry.primaryKey,
      });

    default:
      throw new Error(`Unknown connector type: ${(entry as { type: string }).type}`);
  }
}

async function main(): Promise<void> {
  let logger = new Logger();
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  const configPath = configIndex !== -1 ? args[configIndex + 1] : null;

  if (!configPath) {
    console.error('Usage: datatrust --config <config.json>');
    console.error('');
    console.error('Supported connector types: csv, json, excel, odoo, hubspot, postgresql, mysql');
    console.error('');
    console.error('Example config.json:');
    console.error(JSON.stringify({
      server: { name: 'my-connectors', version: '1.0.0' },
      connectors: [
        { id: 'invoices', name: 'Invoices', type: 'csv', filePath: './invoices.csv' },
        { id: 'partners', name: 'Partners', type: 'odoo', url: 'https://mycompany.odoo.com', database: 'mydb', username: 'user@example.com', password: 'api-key', model: 'res.partner' },
      ],
    }, null, 2));
    process.exit(1);
  }

  try {
    const config = await loadConfig(configPath);
    logger = new Logger({
      level: config.server?.logging?.level,
      format: config.server?.logging?.format,
    });

    for (const entry of config.connectors) {
      const connector = instrumentConnector(createConnector(entry), logger, {
        runtime: entry.runtime,
        defaults: config.server?.runtime?.connectorDefaults,
      });
      registry.register(connector);
    }

    await registry.connectAll();

    await runServer({
      name: config.server?.name ?? 'mcp-enterprise-connectors',
      version: config.server?.version ?? '0.1.0',
      transport: config.server?.transport,
      http: config.server?.http,
      policy: config.server?.policy,
      policyBundle: config.server?.policyBundle,
      tenants: config.server?.tenants,
      logging: config.server?.logging,
      runtime: config.server?.runtime,
      logger,
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

main();
