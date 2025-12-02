/**
 * CSV Connector
 * Reads and writes CSV files with automatic schema inference
 */

import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { Record } from '@datatrust/core';
import { extractFieldNames } from '@datatrust/core';
import {
  BaseFileConnector,
  type FileConnectorConfig,
} from './base-file-connector.js';

export interface CsvConnectorConfig extends FileConnectorConfig {
  type: 'csv';
  /** CSV delimiter (default: ',') */
  delimiter?: string;
  /** Whether first row contains headers (default: true) */
  headers?: boolean;
  /** Quote character (default: '"') */
  quote?: string;
  /** Skip empty lines (default: true) */
  skipEmptyLines?: boolean;
}

export class CsvConnector extends BaseFileConnector<CsvConnectorConfig> {
  constructor(config: Omit<CsvConnectorConfig, 'type'> & { type?: 'csv' }) {
    super({ ...config, type: 'csv' });
  }

  protected async parseContent(content: string | Buffer): Promise<Record[]> {
    const options = {
      columns: this.config.headers !== false, // Default true
      delimiter: this.config.delimiter ?? ',',
      quote: this.config.quote ?? '"',
      skip_empty_lines: this.config.skipEmptyLines !== false, // Default true
      trim: true,
      cast: true, // Auto-convert numbers and booleans
      cast_date: false, // Don't auto-convert dates (can cause issues)
    };

    const records = parse(content, options) as Record[];
    return records;
  }

  protected async serializeContent(records: Record[]): Promise<string> {
    if (records.length === 0) {
      return '';
    }

    const options = {
      header: this.config.headers !== false,
      columns: extractFieldNames(records),
      delimiter: this.config.delimiter ?? ',',
      quote: this.config.quote ?? '"',
    };

    return stringify(records, options);
  }
}

/**
 * Factory function to create a CSV connector
 */
export function createCsvConnector(
  config: Omit<CsvConnectorConfig, 'type'>
): CsvConnector {
  return new CsvConnector(config);
}
