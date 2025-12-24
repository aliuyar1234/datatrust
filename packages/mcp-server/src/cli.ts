#!/usr/bin/env node
/**
 * CLI entry point for the MCP server
 *
 * Usage:
 *   datatrust --config ./config.json
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runServer, registry } from './server.js';
import {
  configFileSchema,
  expandEnvVars,
  formatZodError,
  type ConfigFile,
  type ConnectorEntry,
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
  return result.data;
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
      const connector = instrumentConnector(createConnector(entry), logger);
      registry.register(connector);
    }

    await registry.connectAll();

    await runServer({
      name: config.server?.name ?? 'mcp-enterprise-connectors',
      version: config.server?.version ?? '0.1.0',
      transport: config.server?.transport,
      http: config.server?.http,
      policy: config.server?.policy,
      logging: config.server?.logging,
      logger,
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

main();
