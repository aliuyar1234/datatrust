/**
 * Core Connector Interface
 *
 * All connectors (file, API, database) implement this interface.
 * This enables a unified MCP server that works with any data source.
 */

import type {
  Schema,
  FilterOptions,
  ReadResult,
  WriteResult,
  ValidationResult,
  Record,
} from '../types/index.js';

/** Configuration common to all connectors */
export interface ConnectorConfig {
  /** Unique identifier for this connector instance */
  id: string;
  /** Human-readable name */
  name: string;
  /** Connector type (csv, excel, odoo, postgres, etc.) */
  type: string;
  /** Whether this connector supports write operations */
  readonly?: boolean;
}

/** Connection state */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Base interface all connectors must implement
 */
export interface IConnector<TConfig extends ConnectorConfig = ConnectorConfig> {
  /** Connector configuration */
  readonly config: TConfig;

  /** Current connection state */
  readonly state: ConnectionState;

  /**
   * Initialize the connection to the data source
   * @throws ConnectorError if connection fails
   */
  connect(): Promise<void>;

  /**
   * Close the connection and clean up resources
   */
  disconnect(): Promise<void>;

  /**
   * Get the schema of the data source
   * Auto-infers from the source (CSV headers, DB columns, API spec)
   * @param forceRefresh - Re-infer schema even if cached
   */
  getSchema(forceRefresh?: boolean): Promise<Schema>;

  /**
   * Read records from the data source
   * @param options - Filter, pagination, and field selection
   */
  readRecords(options?: FilterOptions): Promise<ReadResult>;

  /**
   * Write records to the data source
   * @param records - Records to write
   * @param mode - 'insert' (new only), 'update' (existing only), 'upsert' (both)
   * @throws ConnectorError if connector is readonly
   */
  writeRecords(
    records: Record[],
    mode?: 'insert' | 'update' | 'upsert'
  ): Promise<WriteResult>;

  /**
   * Validate records against the schema without writing
   * @param records - Records to validate
   */
  validateRecords(records: Record[]): Promise<ValidationResult[]>;

  /**
   * Test the connection without performing operations
   * @returns true if connection is healthy
   */
  testConnection(): Promise<boolean>;
}

/**
 * Factory function type for creating connectors
 */
export type ConnectorFactory<TConfig extends ConnectorConfig> = (
  config: TConfig
) => IConnector<TConfig>;
