/**
 * HubSpot Connector
 *
 * Implements IConnector for HubSpot CRM objects (contacts, companies, deals).
 */

import type {
  IConnector,
  ConnectorConfig,
  ConnectionState,
  Schema,
  FieldDefinition,
  FieldType,
  FilterOptions,
  FilterOperator,
  ReadResult,
  WriteResult,
  ValidationResult,
  Record as DataRecord,
} from '@datatrust/core';
import { ConnectorError } from '@datatrust/core';
import {
  HubSpotClient,
  type HubSpotObjectType,
  type HubSpotFilterOperator,
  type HubSpotFilter,
} from './client.js';

export interface HubSpotConnectorConfig extends ConnectorConfig {
  type: 'hubspot';
  /** Private App Access Token */
  accessToken: string;
  /** CRM object type */
  objectType: HubSpotObjectType;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/** Map HubSpot field types to our types */
const TYPE_MAP: { [key: string]: FieldType } = {
  string: 'string',
  number: 'number',
  date: 'date',
  datetime: 'datetime',
  enumeration: 'string',
  bool: 'boolean',
  phone_number: 'string',
};

/** Map our operators to HubSpot operators */
const OPERATOR_MAP: { [K in FilterOperator]?: HubSpotFilterOperator } = {
  eq: 'EQ',
  neq: 'NEQ',
  gt: 'GT',
  lt: 'LT',
  gte: 'GTE',
  lte: 'LTE',
  contains: 'CONTAINS_TOKEN',
  in: 'IN',
};

export class HubSpotConnector implements IConnector<HubSpotConnectorConfig> {
  readonly config: HubSpotConnectorConfig;
  private _state: ConnectionState = 'disconnected';
  private _client: HubSpotClient | null = null;
  private _schema: Schema | null = null;

  constructor(config: Omit<HubSpotConnectorConfig, 'type'> & { type?: 'hubspot' }) {
    this.config = { ...config, type: 'hubspot' };
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    this._state = 'connecting';

    try {
      this._client = new HubSpotClient({
        accessToken: this.config.accessToken,
        timeoutMs: this.config.timeoutMs,
      });

      const connected = await this._client.testConnection();
      if (!connected) {
        throw new Error('Connection test failed');
      }

      this._state = 'connected';
    } catch (error) {
      this._state = 'error';

      if (error instanceof ConnectorError) {
        throw error;
      }

      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `Failed to connect to HubSpot: ${(error as Error).message}`,
        connectorId: this.config.id,
        suggestion: 'Check your access token and network connectivity.',
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

    const properties = await this._client!.getProperties(this.config.objectType);
    const fields: FieldDefinition[] = [];

    // Always include id
    fields.push({
      name: 'id',
      type: 'string',
      required: true,
      description: 'HubSpot Record ID',
    });

    for (const prop of properties) {
      // Skip calculated/read-only system fields
      if (prop.calculated && prop.name.startsWith('hs_')) {
        continue;
      }

      const fieldType = TYPE_MAP[prop.type] ?? 'string';

      fields.push({
        name: prop.name,
        type: fieldType,
        required: false, // HubSpot doesn't expose required in properties API
        description: prop.label || prop.description,
      });
    }

    this._schema = {
      name: this.config.objectType,
      description: `HubSpot ${this.config.objectType}`,
      fields,
      primaryKey: 'id',
      inferred: true,
    };

    return this._schema;
  }

  async readRecords(options?: FilterOptions): Promise<ReadResult> {
    this.ensureConnected();

    const hasFilters = options?.where && options.where.length > 0;

    if (hasFilters) {
      return this.searchRecords(options!);
    }

    return this.listRecords(options);
  }

  private async listRecords(options?: FilterOptions): Promise<ReadResult> {
    const limit = Math.min(options?.limit ?? 100, 100);
    // Use cursor if provided, otherwise start from beginning
    const after = options?.cursor;

    const response = await this._client!.list(this.config.objectType, {
      properties: options?.select,
      limit,
      after,
    });

    const records: DataRecord[] = response.results.map((r) => ({
      id: r.id,
      ...r.properties,
    }));

    // Apply sorting in memory (HubSpot list doesn't support sorting)
    if (options?.orderBy?.length) {
      records.sort((a, b) => {
        for (const { field, direction } of options.orderBy!) {
          const aVal = a[field];
          const bVal = b[field];
          const cmp = String(aVal ?? '').localeCompare(String(bVal ?? ''));
          if (cmp !== 0) {
            return direction === 'desc' ? -cmp : cmp;
          }
        }
        return 0;
      });
    }

    return {
      records,
      totalCount: response.total,
      hasMore: !!response.paging?.next?.after,
      nextCursor: response.paging?.next?.after,
    };
  }

  private async searchRecords(options: FilterOptions): Promise<ReadResult> {
    const filters: HubSpotFilter[] = [];

    for (const condition of options.where ?? []) {
      const hsOperator = OPERATOR_MAP[condition.op];
      if (!hsOperator) {
        throw new ConnectorError({
          code: 'VALIDATION_ERROR',
          message: `Unsupported filter operator: ${condition.op}`,
          connectorId: this.config.id,
        });
      }

      filters.push({
        propertyName: condition.field,
        operator: hsOperator,
        value: String(condition.value),
      });
    }

    const searchRequest = {
      filterGroups: [{ filters }],
      properties: options.select,
      limit: Math.min(options.limit ?? 100, 100),
      // Use cursor for pagination (HubSpot's 'after' is cursor-based, not offset)
      after: options.cursor,
      sorts: options.orderBy?.map((o) => ({
        propertyName: o.field,
        direction: o.direction === 'desc' ? 'DESCENDING' as const : 'ASCENDING' as const,
      })),
    };

    const response = await this._client!.search(this.config.objectType, searchRequest);

    const records = response.results.map((r) => ({
      id: r.id,
      ...r.properties,
    }));

    return {
      records,
      totalCount: response.total,
      hasMore: !!response.paging?.next?.after,
      nextCursor: response.paging?.next?.after,
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

    const toCreate: { properties: Record<string, string> }[] = [];
    const toUpdate: { id: string; properties: Record<string, string> }[] = [];

    for (const record of records) {
      const hasId = 'id' in record && record['id'];
      const properties: Record<string, string> = {};

      for (const [key, value] of Object.entries(record)) {
        if (key !== 'id' && value !== null && value !== undefined) {
          properties[key] = String(value);
        }
      }

      if (hasId && (mode === 'update' || mode === 'upsert')) {
        toUpdate.push({ id: String(record['id']), properties });
      } else if (!hasId && (mode === 'insert' || mode === 'upsert')) {
        toCreate.push({ properties });
      } else if (mode === 'insert' && hasId) {
        throw new ConnectorError({
          code: 'VALIDATION_ERROR',
          message: 'Cannot insert record with existing ID',
          connectorId: this.config.id,
        });
      } else if (mode === 'update' && !hasId) {
        throw new ConnectorError({
          code: 'VALIDATION_ERROR',
          message: 'Cannot update record without ID',
          connectorId: this.config.id,
        });
      }
    }

    let success = 0;
    const ids: string[] = [];
    const errors: { index: number; message: string }[] = [];

    // Batch create (max 100 per batch)
    for (let i = 0; i < toCreate.length; i += 100) {
      const batch = toCreate.slice(i, i + 100);
      try {
        const result = await this._client!.batchCreate(this.config.objectType, batch);
        success += result.results.length;
        ids.push(...result.results.map((r) => r.id));
      } catch (error) {
        for (let j = 0; j < batch.length; j++) {
          errors.push({ index: i + j, message: (error as Error).message });
        }
      }
    }

    // Batch update (max 100 per batch)
    for (let i = 0; i < toUpdate.length; i += 100) {
      const batch = toUpdate.slice(i, i + 100);
      try {
        const result = await this._client!.batchUpdate(this.config.objectType, batch);
        success += result.results.length;
        ids.push(...result.results.map((r) => r.id));
      } catch (error) {
        for (let j = 0; j < batch.length; j++) {
          errors.push({
            index: toCreate.length + i + j,
            message: (error as Error).message,
          });
        }
      }
    }

    return {
      success,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      ids,
    };
  }

  async validateRecords(records: DataRecord[]): Promise<ValidationResult[]> {
    // HubSpot has minimal required fields, validation is mostly server-side
    return records.map(() => ({ valid: true }));
  }

  async testConnection(): Promise<boolean> {
    if (!this._client) {
      const client = new HubSpotClient({
        accessToken: this.config.accessToken,
        timeoutMs: this.config.timeoutMs,
      });
      return client.testConnection();
    }
    return this._client.testConnection();
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

export function createHubSpotConnector(
  config: Omit<HubSpotConnectorConfig, 'type'>
): HubSpotConnector {
  return new HubSpotConnector(config);
}
