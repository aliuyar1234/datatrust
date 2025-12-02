/**
 * MySQL Connector
 *
 * Implements IConnector for MySQL databases.
 */

import type {
  IConnector,
  ConnectorConfig,
  ConnectionState,
  Schema,
  FieldDefinition,
  FieldType,
  FilterOptions,
  ReadResult,
  WriteResult,
  ValidationResult,
  Record as DataRecord,
} from '@datatrust/core';
import { ConnectorError } from '@datatrust/core';
import { MySQLClient, type MySQLClientConfig } from './client.js';

export interface MySQLConnectorConfig extends ConnectorConfig {
  type: 'mysql';
  /** Connection URI (alternative to individual params) */
  uri?: string;
  /** Database host */
  host?: string;
  /** Database port */
  port?: number;
  /** Database name */
  database?: string;
  /** Username */
  user?: string;
  /** Password */
  password?: string;
  /** SSL configuration */
  ssl?: boolean | { rejectUnauthorized?: boolean };
  /** Table to connect to */
  table: string;
  /** Primary key column (default: id) */
  primaryKey?: string;
}

/** Map MySQL types to our types */
const TYPE_MAP: Record<string, FieldType> = {
  // Numeric
  tinyint: 'integer',
  smallint: 'integer',
  mediumint: 'integer',
  int: 'integer',
  bigint: 'integer',
  decimal: 'number',
  float: 'number',
  double: 'number',
  // Text
  char: 'string',
  varchar: 'string',
  tinytext: 'string',
  text: 'string',
  mediumtext: 'string',
  longtext: 'string',
  // Binary
  binary: 'string',
  varbinary: 'string',
  blob: 'string',
  // Boolean (MySQL uses tinyint(1))
  bit: 'boolean',
  // Date/Time
  date: 'date',
  datetime: 'datetime',
  timestamp: 'datetime',
  time: 'string',
  year: 'integer',
  // JSON
  json: 'object',
  // Enum/Set
  enum: 'string',
  set: 'array',
};

export class MySQLConnector implements IConnector<MySQLConnectorConfig> {
  readonly config: MySQLConnectorConfig;
  private _state: ConnectionState = 'disconnected';
  private _client: MySQLClient | null = null;
  private _schema: Schema | null = null;

  constructor(config: Omit<MySQLConnectorConfig, 'type'> & { type?: 'mysql' }) {
    this.config = { ...config, type: 'mysql' };
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    this._state = 'connecting';

    try {
      const clientConfig: MySQLClientConfig = {
        uri: this.config.uri,
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        ssl: this.config.ssl,
      };

      this._client = new MySQLClient(clientConfig);
      await this._client.connect();

      this._state = 'connected';
    } catch (error) {
      this._state = 'error';

      if (error instanceof ConnectorError) {
        throw error;
      }

      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `Failed to connect to MySQL: ${(error as Error).message}`,
        connectorId: this.config.id,
        suggestion: 'Check connection parameters and network connectivity.',
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this._client) {
      await this._client.disconnect();
    }
    this._client = null;
    this._schema = null;
    this._state = 'disconnected';
  }

  async getSchema(forceRefresh = false): Promise<Schema> {
    this.ensureConnected();

    if (this._schema && !forceRefresh) {
      return this._schema;
    }

    const columns = await this._client!.getColumns(this.config.table);
    const fields: FieldDefinition[] = [];
    let primaryKey = this.config.primaryKey ?? 'id';

    for (const col of columns) {
      const fieldType = TYPE_MAP[col.dataType] ?? 'string';

      fields.push({
        name: col.name,
        type: fieldType,
        required: !col.isNullable && !col.columnDefault,
        description: `${col.dataType}${col.isPrimaryKey ? ' (primary key)' : ''}`,
      });

      if (col.isPrimaryKey) {
        primaryKey = col.name;
      }
    }

    this._schema = {
      name: this.config.table,
      description: `MySQL table: ${this.config.table}`,
      fields,
      primaryKey,
      inferred: true,
    };

    return this._schema;
  }

  async readRecords(options?: FilterOptions): Promise<ReadResult> {
    this.ensureConnected();

    const where = options?.where?.map((w) => ({
      column: w.field,
      op: w.op,
      value: w.op === 'contains' ? `%${w.value}%` : w.value,
    }));

    const [records, totalCount] = await Promise.all([
      this._client!.select(this.config.table, {
        columns: options?.select,
        where,
        orderBy: options?.orderBy?.map((o) => ({
          column: o.field,
          direction: o.direction,
        })),
        limit: options?.limit,
        offset: options?.offset,
      }),
      this._client!.count(this.config.table, { where }),
    ]);

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? records.length;
    const hasMore = offset + limit < totalCount;

    return {
      records: records as DataRecord[],
      totalCount,
      hasMore,
    };
  }

  async writeRecords(
    records: DataRecord[],
    mode: 'insert' | 'update' | 'upsert' = 'upsert'
  ): Promise<WriteResult> {
    this.ensureConnected();

    if (this.config.readonly) {
      throw new ConnectorError({
        code: 'UNSUPPORTED_OPERATION',
        message: 'Connector is read-only',
        connectorId: this.config.id,
      });
    }

    const schema = await this.getSchema();
    const pkRaw = schema.primaryKey ?? 'id';
    const pk = Array.isArray(pkRaw) ? pkRaw[0]! : pkRaw;

    let success = 0;
    let failed = 0;
    const errors: { index: number; message: string; record?: DataRecord }[] = [];
    const ids: (string | number)[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;

      try {
        const hasId = pk in record && record[pk] !== null && record[pk] !== undefined;

        if (mode === 'insert' && hasId) {
          throw new Error('Cannot insert record with existing ID');
        }

        if (mode === 'update' && !hasId) {
          throw new Error('Cannot update record without ID');
        }

        if (hasId && (mode === 'update' || mode === 'upsert')) {
          // Update existing record
          const id = record[pk] as string | number;
          const values = { ...record };
          delete values[pk];

          await this._client!.update(
            this.config.table,
            values,
            [{ column: pk, value: id }]
          );
          ids.push(id);
        } else {
          // Insert new record
          const values = { ...record };
          delete values[pk];

          const insertId = await this._client!.insert(this.config.table, values);
          ids.push(insertId);
        }

        success++;
      } catch (error) {
        failed++;
        errors.push({
          index: i,
          message: (error as Error).message,
          record,
        });
      }
    }

    return {
      success,
      failed,
      errors: errors.length > 0 ? errors : undefined,
      ids,
    };
  }

  async validateRecords(records: DataRecord[]): Promise<ValidationResult[]> {
    const schema = await this.getSchema();
    const results: ValidationResult[] = [];
    const pkRaw = schema.primaryKey ?? 'id';
    const pkFields = Array.isArray(pkRaw) ? pkRaw : [pkRaw];

    for (const record of records) {
      const errors: { field: string; message: string; value?: unknown }[] = [];

      for (const field of schema.fields) {
        const value = record[field.name];

        // Check required fields (skip primary key for new records)
        if (
          field.required &&
          !pkFields.includes(field.name) &&
          (value === null || value === undefined || value === '')
        ) {
          errors.push({
            field: field.name,
            message: `Required field '${field.name}' is missing`,
          });
        }
      }

      results.push({
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    return results;
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this._client) {
        const clientConfig: MySQLClientConfig = {
          uri: this.config.uri,
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          user: this.config.user,
          password: this.config.password,
          ssl: this.config.ssl,
        };
        const testClient = new MySQLClient(clientConfig);
        await testClient.connect();
        await testClient.disconnect();
        return true;
      }

      await this._client.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private ensureConnected(): void {
    if (this._state !== 'connected' || !this._client) {
      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: 'Connector is not connected',
        connectorId: this.config.id,
        suggestion: 'Call connect() before performing operations.',
      });
    }
  }
}

/**
 * Factory function to create a MySQL connector
 */
export function createMySQLConnector(
  config: Omit<MySQLConnectorConfig, 'type'>
): MySQLConnector {
  return new MySQLConnector(config);
}
