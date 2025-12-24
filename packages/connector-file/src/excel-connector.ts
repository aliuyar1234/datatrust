/**
 * Excel Connector
 * Reads and writes Excel files (.xlsx) with automatic schema inference
 */

import ExcelJS from 'exceljs';
import type { Record } from '@datatrust/core';
import { ConnectorError, extractFieldNames } from '@datatrust/core';
import {
  BaseFileConnector,
  type FileConnectorConfig,
} from './base-file-connector.js';

export interface ExcelConnectorConfig extends FileConnectorConfig {
  type: 'excel';
  /** Sheet name or index (default: first sheet) */
  sheet?: string | number;
  /** Whether first row contains headers (default: true) */
  headers?: boolean;
  /** Starting row (1-indexed, default: 1) */
  startRow?: number;
  /** Starting column (1-indexed, default: 1) */
  startColumn?: number;
}

const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class ExcelConnector extends BaseFileConnector<ExcelConnectorConfig> {   
  private _workbook: ExcelJS.Workbook | null = null;

  constructor(config: Omit<ExcelConnectorConfig, 'type'> & { type?: 'excel' }) {
    super({ ...config, type: 'excel' });
  }

  protected async parseContent(_content: string | Buffer): Promise<Record[]> {
    // ExcelJS needs to read from file directly for better handling
    this._workbook = new ExcelJS.Workbook();
    await this._workbook.xlsx.readFile(this.config.filePath);

    // Get the target sheet
    const sheet = this.getSheet();
    if (!sheet) {
      throw new ConnectorError({
        code: 'NOT_FOUND',
        message: `Sheet not found: ${this.config.sheet ?? 'first sheet'}`,
        connectorId: this.config.id,
        suggestion: 'Check that the sheet name/index is correct.',
      });
    }

    const startRow = this.config.startRow ?? 1;
    const startColumn = this.config.startColumn ?? 1;
    const hasHeaders = this.config.headers !== false;

    // Get headers from first row or generate column names
    const headers: string[] = [];
    if (hasHeaders) {
      const headerRow = sheet.getRow(startRow);
      headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {        
        if (colNumber >= startColumn) {
          headers[colNumber - startColumn] = String(cell.value ?? `Column${colNumber}`);
        }
      });

      for (const header of headers) {
        if (FORBIDDEN_RECORD_KEYS.has(header)) {
          throw new ConnectorError({
            code: 'SCHEMA_MISMATCH',
            message: `Unsafe Excel header name: ${header}`,
            connectorId: this.config.id,
            suggestion: 'Rename the column to a safe field name and try again.',
          });
        }
      }
    } else {
      // Generate column names (A, B, C, ... AA, AB, etc.)
      const colCount = sheet.columnCount;
      for (let i = 0; i < colCount - startColumn + 1; i++) {
        headers[i] = this.getColumnName(i + startColumn);
      }
    }

    // Read data rows
    const records: Record[] = [];
    const dataStartRow = hasHeaders ? startRow + 1 : startRow;

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber < dataStartRow) return;

      const record: Record = Object.create(null);
      let hasData = false;

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber < startColumn) return;

        const headerIndex = colNumber - startColumn;
        const header = headers[headerIndex];
        if (!header) return;

        const value = this.getCellValue(cell);
        if (value !== null && value !== undefined && value !== '') {
          hasData = true;
        }
        record[header] = value;
      });

      // Only add row if it has some data
      if (hasData) {
        records.push(record);
      }
    });

    return records;
  }

  protected async serializeContent(records: Record[]): Promise<Buffer> {
    if (!this._workbook) {
      this._workbook = new ExcelJS.Workbook();
    }

    // Get or create sheet
    let sheet = this.getSheet();
    if (!sheet) {
      const sheetName =
        typeof this.config.sheet === 'string' ? this.config.sheet : 'Sheet1';
      sheet = this._workbook.addWorksheet(sheetName);
    }

    // Clear existing data
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.value = null;
      });
    });

    if (records.length === 0) {
      const buffer = await this._workbook.xlsx.writeBuffer();
      return Buffer.from(buffer);
    }

    const headers = extractFieldNames(records);

    const startRow = this.config.startRow ?? 1;
    const startColumn = this.config.startColumn ?? 1;
    const hasHeaders = this.config.headers !== false;

    // Write headers
    if (hasHeaders) {
      const headerRow = sheet.getRow(startRow);
      headers.forEach((header, index) => {
        headerRow.getCell(startColumn + index).value = header;
      });
      headerRow.font = { bold: true };
    }

    // Write data
    const dataStartRow = hasHeaders ? startRow + 1 : startRow;
    records.forEach((record, rowIndex) => {
      const row = sheet.getRow(dataStartRow + rowIndex);
      headers.forEach((header, colIndex) => {
        const value = record[header];
        row.getCell(startColumn + colIndex).value =
          value === undefined ? null : (value as ExcelJS.CellValue);
      });
    });

    // Auto-fit columns (approximate)
    sheet.columns.forEach((column) => {
      column.width = 15;
    });

    const buffer = await this._workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private getSheet(): ExcelJS.Worksheet | undefined {
    if (!this._workbook) return undefined;

    if (typeof this.config.sheet === 'string') {
      return this._workbook.getWorksheet(this.config.sheet);
    }

    if (typeof this.config.sheet === 'number') {
      return this._workbook.getWorksheet(this.config.sheet);
    }

    // Default: first sheet
    return this._workbook.worksheets[0];
  }

  private getCellValue(cell: ExcelJS.Cell): unknown {
    const value = cell.value;

    if (value === null || value === undefined) {
      return null;
    }

    // Handle formula results
    if (typeof value === 'object' && 'result' in value) {
      return (value as ExcelJS.CellFormulaValue).result;
    }

    // Handle rich text
    if (typeof value === 'object' && 'richText' in value) {
      return (value as ExcelJS.CellRichTextValue).richText
        .map((rt) => rt.text)
        .join('');
    }

    // Handle hyperlinks
    if (typeof value === 'object' && 'hyperlink' in value) {
      return (value as ExcelJS.CellHyperlinkValue).text;
    }

    // Handle dates
    if (value instanceof Date) {
      return value.toISOString();
    }

    return value;
  }

  private getColumnName(colNumber: number): string {
    let name = '';
    let n = colNumber;

    while (n > 0) {
      const remainder = (n - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      n = Math.floor((n - 1) / 26);
    }

    return name;
  }
}

/**
 * Factory function to create an Excel connector
 */
export function createExcelConnector(
  config: Omit<ExcelConnectorConfig, 'type'>
): ExcelConnector {
  return new ExcelConnector(config);
}
