/**
 * PostgreSQL Connector
 *
 * Exports for PostgreSQL database integration.
 */

export { PostgresClient } from './client.js';
export type {
  PostgresClientConfig,
  PostgresColumn,
  PostgresQueryResult,
} from './client.js';

export { PostgresConnector, createPostgresConnector } from './connector.js';
export type { PostgresConnectorConfig } from './connector.js';
