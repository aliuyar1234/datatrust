/**
 * CSV Connector
 * Reads and writes CSV files with automatic schema inference
 */

import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { Record } from '@datatrust/core';
import { ConnectorError, extractFieldNames } from '@datatrust/core';
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
  /**
   * Mitigate CSV/Excel formula injection on write by prefixing strings that start
   * with =, +, -, or @ (after optional whitespace). Default: true.
   */
  sanitizeFormulas?: boolean;
  /** Prefix used when sanitizeFormulas is enabled (default: "'"). */
  formulaEscapePrefix?: string;
}

const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function sanitizeFormulaValue(
  value: unknown,
  enabled: boolean,
  prefix: string
): unknown {
  if (!enabled || typeof value !== 'string') return value;
  if (value.startsWith(prefix)) return value;
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `${prefix}${value}` : value;
}

export class CsvConnector extends BaseFileConnector<CsvConnectorConfig> {       
  constructor(config: Omit<CsvConnectorConfig, 'type'> & { type?: 'csv' }) {    
    super({ ...config, type: 'csv' });
  }

  protected async parseContent(content: string | Buffer): Promise<Record[]> {   
    const options = {
      columns: false, // Parse rows first so we can safely map headers ourselves
      delimiter: this.config.delimiter ?? ',',
      quote: this.config.quote ?? '"',
      skip_empty_lines: this.config.skipEmptyLines !== false, // Default true   
      trim: true,
      cast: true, // Auto-convert numbers and booleans
      cast_date: false, // Don't auto-convert dates (can cause issues)
    };

    const rows = parse(content, options) as unknown[][];
    if (rows.length === 0) return [];

    const hasHeaders = this.config.headers !== false;
    const headerRow = hasHeaders ? rows[0] : null;

    const headers = hasHeaders
      ? headerRow!.map((h) => String(h ?? ''))
      : Array.from(
          { length: Math.max(...rows.map((r) => r.length)) },
          (_, i) => `Column${i + 1}`
        );

    for (const header of headers) {
      if (FORBIDDEN_RECORD_KEYS.has(header)) {
        throw new ConnectorError({
          code: 'SCHEMA_MISMATCH',
          message: `Unsafe CSV header name: ${header}`,
          connectorId: this.config.id,
          suggestion: 'Rename the column to a safe field name and try again.',
        });
      }
    }

    const dataRows = hasHeaders ? rows.slice(1) : rows;
    return dataRows.map((row) => {
      const record: Record = Object.create(null);
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i]!;
        record[key] = row[i];
      }
      return record;
    });
  }

  protected async serializeContent(records: Record[]): Promise<string> {        
    if (records.length === 0) {
      return '';
    }

    const sanitize = this.config.sanitizeFormulas !== false;
    const prefix = this.config.formulaEscapePrefix ?? "'";

    const options = {
      header: this.config.headers !== false,
      columns: extractFieldNames(records),
      delimiter: this.config.delimiter ?? ',',
      quote: this.config.quote ?? '"',
    };

    const outputRecords = sanitize
      ? records.map((record) => {
          const sanitized: Record = Object.create(null);
          for (const key of Object.keys(record)) {
            sanitized[key] = sanitizeFormulaValue(record[key], true, prefix);
          }
          return sanitized;
        })
      : records;

    return stringify(outputRecords, options);
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
