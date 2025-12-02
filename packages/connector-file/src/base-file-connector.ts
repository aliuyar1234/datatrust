/**
 * Base class for file-based connectors
 * Handles common functionality: caching, schema inference, in-memory filtering
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type {
  IConnector,
  ConnectorConfig,
  ConnectionState,
  Schema,
  FilterOptions,
  ReadResult,
  WriteResult,
  ValidationResult,
  Record,
  FieldDefinition,
  FieldType,
} from '@datatrust/core';
import { ConnectorError, applyFilter, countMatching } from '@datatrust/core';

export interface FileConnectorConfig extends ConnectorConfig {
  /** Path to the file */
  filePath: string;
  /** Character encoding (default: utf-8) */
  encoding?: BufferEncoding;
}

/**
 * Infer field type from a sample value
 */
function inferFieldType(value: unknown): FieldType {
  if (value === null || value === undefined) {
    return 'string'; // Default for null/undefined
  }

  if (typeof value === 'boolean') {
    return 'boolean';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }

  if (value instanceof Date) {
    return 'datetime';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  if (typeof value === 'object') {
    return 'object';
  }

  // String - check for date patterns
  const strValue = String(value);

  // ISO date pattern
  if (/^\d{4}-\d{2}-\d{2}$/.test(strValue)) {
    return 'date';
  }

  // ISO datetime pattern
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(strValue)) {
    return 'datetime';
  }

  // Number stored as string
  if (/^-?\d+$/.test(strValue)) {
    return 'integer';
  }

  if (/^-?\d+\.?\d*$/.test(strValue)) {
    return 'number';
  }

  return 'string';
}

/**
 * Infer schema from records by analyzing field values
 */
export function inferSchemaFromRecords(
  name: string,
  records: Record[],
  description?: string
): Schema {
  if (records.length === 0) {
    return {
      name,
      description,
      fields: [],
      inferred: true,
    };
  }

  // Collect all unique field names
  const fieldNames = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      fieldNames.add(key);
    }
  }

  // Analyze each field
  const fields: FieldDefinition[] = [];

  for (const fieldName of fieldNames) {
    // Sample values from records
    const values = records
      .map((r) => r[fieldName])
      .filter((v) => v !== null && v !== undefined && v !== '');

    // Infer type from non-empty values
    const types = values.map(inferFieldType);
    const typeCount = new Map<FieldType, number>();
    for (const type of types) {
      typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
    }

    // Use most common type, default to string
    let inferredType: FieldType = 'string';
    let maxCount = 0;
    for (const [type, count] of typeCount) {
      if (count > maxCount) {
        maxCount = count;
        inferredType = type;
      }
    }

    // Check if field is required (present in all records with non-empty value)
    const required = values.length === records.length;

    fields.push({
      name: fieldName,
      type: inferredType,
      required,
      example: values[0],
    });
  }

  return {
    name,
    description,
    fields,
    inferred: true,
  };
}

/**
 * Abstract base class for file connectors
 */
export abstract class BaseFileConnector<TConfig extends FileConnectorConfig>
  implements IConnector<TConfig>
{
  readonly config: TConfig;
  protected _state: ConnectionState = 'disconnected';
  protected _schema: Schema | null = null;
  protected _records: Record[] = [];

  constructor(config: TConfig) {
    this.config = config;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    this._state = 'connecting';

    try {
      // Check file exists and is readable
      await access(this.config.filePath, constants.R_OK);

      // Read and parse the file
      const content = await readFile(
        this.config.filePath,
        this.config.encoding ?? 'utf-8'
      );

      this._records = await this.parseContent(content);
      this._state = 'connected';
    } catch (error) {
      this._state = 'error';

      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConnectorError({
          code: 'NOT_FOUND',
          message: `File not found: ${this.config.filePath}`,
          connectorId: this.config.id,
          suggestion: 'Check that the file path is correct and the file exists.',
        });
      }

      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        throw new ConnectorError({
          code: 'PERMISSION_DENIED',
          message: `Cannot read file: ${this.config.filePath}`,
          connectorId: this.config.id,
          suggestion: 'Check file permissions.',
        });
      }

      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `Failed to read file: ${(error as Error).message}`,
        connectorId: this.config.id,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async disconnect(): Promise<void> {
    this._records = [];
    this._schema = null;
    this._state = 'disconnected';
  }

  async getSchema(forceRefresh = false): Promise<Schema> {
    this.ensureConnected();

    if (!this._schema || forceRefresh) {
      this._schema = inferSchemaFromRecords(
        this.config.name,
        this._records,
        `Schema for ${this.config.filePath}`
      );
    }

    return this._schema;
  }

  async readRecords(options?: FilterOptions): Promise<ReadResult> {
    this.ensureConnected();

    const totalCount = countMatching(this._records, options?.where);
    const filtered = applyFilter(this._records, options);

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? filtered.length;
    const hasMore = offset + limit < totalCount;

    return {
      records: filtered,
      totalCount,
      hasMore,
    };
  }

  async writeRecords(
    records: Record[],
    _mode: 'insert' | 'update' | 'upsert' = 'insert'
  ): Promise<WriteResult> {
    this.ensureConnected();

    if (this.config.readonly) {
      throw new ConnectorError({
        code: 'UNSUPPORTED_OPERATION',
        message: 'This connector is configured as read-only',
        connectorId: this.config.id,
        suggestion: 'Create a new connector with readonly: false to enable writes.',
      });
    }

    try {
      // For file connectors, we append new records
      // TODO: Implement update/upsert with primary key matching
      this._records.push(...records);

      // Serialize and write back to file
      const content = await this.serializeContent(this._records);
      await writeFile(this.config.filePath, content, this.config.encoding ?? 'utf-8');

      // Invalidate schema cache (new records might have new fields)
      this._schema = null;

      return {
        success: records.length,
        failed: 0,
      };
    } catch (error) {
      throw new ConnectorError({
        code: 'WRITE_FAILED',
        message: `Failed to write records: ${(error as Error).message}`,
        connectorId: this.config.id,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async validateRecords(records: Record[]): Promise<ValidationResult[]> {
    const schema = await this.getSchema();
    const results: ValidationResult[] = [];

    for (const record of records) {
      const errors: { field: string; message: string; value?: unknown }[] = [];

      for (const field of schema.fields) {
        const value = record[field.name];

        // Check required fields
        if (field.required && (value === null || value === undefined || value === '')) {
          errors.push({
            field: field.name,
            message: `Required field '${field.name}' is missing or empty`,
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
      await access(this.config.filePath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  protected ensureConnected(): void {
    if (this._state !== 'connected') {
      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: 'Connector is not connected',
        connectorId: this.config.id,
        suggestion: 'Call connect() before performing operations.',
      });
    }
  }

  /**
   * Parse file content into records (implemented by subclasses)
   */
  protected abstract parseContent(content: string | Buffer): Promise<Record[]>;

  /**
   * Serialize records back to file content (implemented by subclasses)
   */
  protected abstract serializeContent(records: Record[]): Promise<string | Buffer>;
}
