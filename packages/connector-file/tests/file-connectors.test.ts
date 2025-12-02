import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { createCsvConnector, createExcelConnector, createJsonConnector } from '../src/index.js';

let tmpDir = '';

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('File connector edge cases', () => {
  it('handles empty CSV files gracefully', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'connector-file-'));
    const filePath = join(tmpDir, 'empty.csv');
    writeFileSync(filePath, '');

    const connector = createCsvConnector({
      id: 'csv-empty',
      name: 'empty',
      filePath,
      headers: true,
    });

    await connector.connect();
    const result = await connector.readRecords();

    expect(result.records).toHaveLength(0);
    const schema = await connector.getSchema();
    expect(schema.fields).toHaveLength(0);
  });

  it('reads Excel files with merged cells without throwing', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'connector-file-'));
    const filePath = join(tmpDir, 'merged.xlsx');

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Sheet1');
    sheet.mergeCells('B1:C1');
    sheet.getCell('A1').value = 'name';
    sheet.getCell('B1').value = 'amount';
    sheet.getCell('A2').value = 'Alice';
    sheet.getCell('B2').value = 10;
    await wb.xlsx.writeFile(filePath);

    const connector = createExcelConnector({
      id: 'excel-merged',
      name: 'merged',
      filePath,
      headers: true,
    });

    await connector.connect();
    const result = await connector.readRecords();

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.name).toBe('Alice');
    expect(result.records[0]?.amount).toBe(10);
  });

  it('preserves nested objects via recordsPath in JSON connector', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'connector-file-'));
    const filePath = join(tmpDir, 'nested.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        data: { items: [{ id: 1, nested: { a: 1, b: 'x' } }] },
      }),
      'utf-8'
    );

    const connector = createJsonConnector({
      id: 'json-nested',
      name: 'nested',
      filePath,
      recordsPath: 'data.items',
    });

    await connector.connect();
    const result = await connector.readRecords();

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.nested).toEqual({ a: 1, b: 'x' });
  });
});
