/**
 * @datatrust/connector-file
 *
 * File-based connectors for CSV, Excel, and JSON files
 */

export { BaseFileConnector, inferSchemaFromRecords } from './base-file-connector.js';
export type { FileConnectorConfig } from './base-file-connector.js';

export { CsvConnector, createCsvConnector } from './csv-connector.js';
export type { CsvConnectorConfig } from './csv-connector.js';

export { JsonConnector, createJsonConnector } from './json-connector.js';
export type { JsonConnectorConfig } from './json-connector.js';

export { ExcelConnector, createExcelConnector } from './excel-connector.js';
export type { ExcelConnectorConfig } from './excel-connector.js';

// Re-export core types for convenience
export type {
  IConnector,
  ConnectorConfig,
  ConnectionState,
  Schema,
  FilterOptions,
  ReadResult,
  WriteResult,
  ValidationResult,
  Record,
} from '@datatrust/core';
