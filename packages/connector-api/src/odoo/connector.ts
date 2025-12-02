/**
 * Odoo Connector
 *
 * Implements the IConnector interface for Odoo ERP.
 * Supports reading/writing records via JSON-RPC API.
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
import { OdooClient, type OdooClientConfig } from './client.js';
import { toDomain } from './domain.js';

export interface OdooConnectorConfig extends ConnectorConfig {
  type: 'odoo';
  /** Odoo server URL */
  url: string;
  /** Database name */
  database: string;
  /** Username (email) */
  username: string;
  /** Password or API key */
  password: string;
  /** Odoo model to connect to (e.g., 'res.partner', 'account.move') */
  model: string;
}

/** Map Odoo field types to our types */
const TYPE_MAP: { [key: string]: FieldType } = {
  char: 'string',
  text: 'string',
  html: 'string',
  integer: 'integer',
  float: 'number',
  monetary: 'number',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
  binary: 'string',
  selection: 'string',
  many2one: 'integer', // Returns ID
  one2many: 'array',
  many2many: 'array',
};

export class OdooConnector implements IConnector<OdooConnectorConfig> {
  readonly config: OdooConnectorConfig;
  private _state: ConnectionState = 'disconnected';
  private _client: OdooClient | null = null;
  private _schema: Schema | null = null;

  constructor(config: Omit<OdooConnectorConfig, 'type'> & { type?: 'odoo' }) {
    this.config = { ...config, type: 'odoo' };
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    this._state = 'connecting';

    try {
      const clientConfig: OdooClientConfig = {
        url: this.config.url,
        database: this.config.database,
        username: this.config.username,
        password: this.config.password,
      };

      this._client = new OdooClient(clientConfig);
      await this._client.authenticate();

      this._state = 'connected';
    } catch (error) {
      this._state = 'error';

      if (error instanceof ConnectorError) {
        throw error;
      }

      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `Failed to connect to Odoo: ${(error as Error).message}`,
        connectorId: this.config.id,
        cause: error instanceof Error ? error : undefined,
        suggestion: 'Check URL, database, username, and password.',
      });
    }
  }

  async disconnect(): Promise<void> {
    this._client = null;
    this._schema = null;
    this._state = 'disconnected';
  }

  async getSchema(forceRefresh = false): Promise<Schema> {
    this.ensureConnected();

    if (this._schema && !forceRefresh) {
      return this._schema;
    }

    const odooFields = await this._client!.fieldsGet(this.config.model);
    const fields: FieldDefinition[] = [];

    for (const [name, meta] of Object.entries(odooFields)) {
      // Skip internal fields
      if (name.startsWith('__') || name === 'id') {
        continue;
      }

      const odooType = meta['type'] as string;
      const fieldType = TYPE_MAP[odooType] ?? 'string';

      fields.push({
        name,
        type: fieldType,
        required: (meta['required'] as boolean) ?? false,
        description: meta['string'] as string | undefined,
      });
    }

    // Always include id field
    fields.unshift({
      name: 'id',
      type: 'integer',
      required: true,
      description: 'Record ID',
    });

    this._schema = {
      name: this.config.model,
      description: `Odoo model: ${this.config.model}`,
      fields,
      primaryKey: 'id',
      inferred: true,
    };

    return this._schema;
  }

  async readRecords(options?: FilterOptions): Promise<ReadResult> {
    this.ensureConnected();

    const domain = toDomain(options?.where);

    // Build Odoo search_read options
    const searchOptions: {
      fields?: string[];
      offset?: number;
      limit?: number;
      order?: string;
    } = {};

    if (options?.select && options.select.length > 0) {
      searchOptions.fields = options.select;
    }

    if (options?.offset !== undefined) {
      searchOptions.offset = options.offset;
    }

    if (options?.limit !== undefined) {
      searchOptions.limit = options.limit;
    }

    if (options?.orderBy && options.orderBy.length > 0) {
      searchOptions.order = options.orderBy
        .map((o) => `${o.field} ${o.direction}`)
        .join(', ');
    }

    const [records, totalCount] = await Promise.all([
      this._client!.searchRead(this.config.model, domain, searchOptions),
      this._client!.searchCount(this.config.model, domain),
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

    let success = 0;
    let failed = 0;
    const errors: { index: number; message: string; record?: DataRecord }[] = [];
    const ids: number[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;

      try {
        const hasId = 'id' in record && typeof record['id'] === 'number';

        if (mode === 'insert' && hasId) {
          throw new Error('Cannot insert record with existing ID');
        }

        if (mode === 'update' && !hasId) {
          throw new Error('Cannot update record without ID');
        }

        if (hasId && (mode === 'update' || mode === 'upsert')) {
          // Update existing record
          const id = record['id'] as number;
          const values = { ...record };
          delete values['id'];

          await this._client!.write(this.config.model, [id], values);
          ids.push(id);
        } else {
          // Create new record
          const values = { ...record };
          delete values['id'];

          const id = await this._client!.create(this.config.model, values);
          ids.push(id);
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

    for (const record of records) {
      const errors: { field: string; message: string; value?: unknown }[] = [];

      for (const field of schema.fields) {
        const value = record[field.name];

        // Check required fields (skip 'id' for new records)
        if (
          field.required &&
          field.name !== 'id' &&
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
        const clientConfig: OdooClientConfig = {
          url: this.config.url,
          database: this.config.database,
          username: this.config.username,
          password: this.config.password,
        };
        const testClient = new OdooClient(clientConfig);
        await testClient.version();
        return true;
      }

      await this._client.version();
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
 * Factory function to create an Odoo connector
 */
export function createOdooConnector(
  config: Omit<OdooConnectorConfig, 'type'>
): OdooConnector {
  return new OdooConnector(config);
}
