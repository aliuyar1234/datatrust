#!/usr/bin/env node
/**
 * CLI entry point for the MCP server
 *
 * Usage:
 *   mcp-connectors --config ./config.json
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runServer, registry } from './server.js';
import {
  createCsvConnector,
  createJsonConnector,
  createExcelConnector,
} from '@datatrust/connector-file';
import { createOdooConnector, createHubSpotConnector } from '@datatrust/connector-api';
import { createPostgresConnector, createMySQLConnector } from '@datatrust/connector-db';

/** File connector config */
interface FileConnectorEntry {
  id: string;
  name: string;
  type: 'csv' | 'json' | 'excel';
  filePath: string;
  readonly?: boolean;
  delimiter?: string;
  headers?: boolean;
  recordsPath?: string;
  sheet?: string | number;
}

/** Odoo connector config */
interface OdooConnectorEntry {
  id: string;
  name: string;
  type: 'odoo';
  url: string;
  database: string;
  username: string;
  password: string;
  model: string;
  readonly?: boolean;
}

/** HubSpot connector config */
interface HubSpotConnectorEntry {
  id: string;
  name: string;
  type: 'hubspot';
  accessToken: string;
  objectType: 'contacts' | 'companies' | 'deals' | 'tickets';
  readonly?: boolean;
}

/** PostgreSQL connector config */
interface PostgresConnectorEntry {
  id: string;
  name: string;
  type: 'postgresql';
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  table: string;
  schema?: string;
  primaryKey?: string;
  readonly?: boolean;
}

/** MySQL connector config */
interface MySQLConnectorEntry {
  id: string;
  name: string;
  type: 'mysql';
  uri?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  table: string;
  primaryKey?: string;
  readonly?: boolean;
}

type ConnectorConfigEntry =
  | FileConnectorEntry
  | OdooConnectorEntry
  | HubSpotConnectorEntry
  | PostgresConnectorEntry
  | MySQLConnectorEntry;

interface ConfigFile {
  server?: {
    name?: string;
    version?: string;
  };
  connectors: ConnectorConfigEntry[];
}

async function loadConfig(configPath: string): Promise<ConfigFile> {
  const absolutePath = resolve(process.cwd(), configPath);
  const content = await readFile(absolutePath, 'utf-8');
  return JSON.parse(content) as ConfigFile;
}

function createConnector(entry: ConnectorConfigEntry) {
  switch (entry.type) {
    case 'csv':
      return createCsvConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        filePath: resolve(process.cwd(), entry.filePath),
        delimiter: entry.delimiter,
        headers: entry.headers,
      });

    case 'json':
      return createJsonConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        filePath: resolve(process.cwd(), entry.filePath),
        recordsPath: entry.recordsPath,
      });

    case 'excel':
      return createExcelConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        filePath: resolve(process.cwd(), entry.filePath),
        sheet: entry.sheet,
        headers: entry.headers,
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
      });

    case 'hubspot':
      return createHubSpotConnector({
        id: entry.id,
        name: entry.name,
        readonly: entry.readonly,
        accessToken: entry.accessToken,
        objectType: entry.objectType,
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
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  const configPath = configIndex !== -1 ? args[configIndex + 1] : null;

  if (!configPath) {
    console.error('Usage: mcp-connectors --config <config.json>');
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

    for (const entry of config.connectors) {
      const connector = createConnector(entry);
      registry.register(connector);
    }

    await registry.connectAll();

    await runServer({
      name: config.server?.name ?? 'mcp-enterprise-connectors',
      version: config.server?.version ?? '0.1.0',
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
