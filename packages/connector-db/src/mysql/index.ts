/**
 * MySQL Connector
 *
 * Exports for MySQL database integration.
 */

export { MySQLClient } from './client.js';
export type {
  MySQLClientConfig,
  MySQLColumn,
  MySQLQueryResult,
} from './client.js';

export { MySQLConnector, createMySQLConnector } from './connector.js';
export type { MySQLConnectorConfig } from './connector.js';
