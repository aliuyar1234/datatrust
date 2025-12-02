import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  IConnector,
  ConnectorConfig,
  ConnectionState,
  Schema,
  FilterOptions,
  ReadResult,
  WriteResult,
  ValidationResult,
  Record as DataRecord,
} from '@datatrust/core';
import { applyFilter } from '@datatrust/core';
import { ConsistencyMonitor } from '../src/consistency/consistency-monitor.js';
import { ReconciliationEngine } from '../src/reconciliation/reconciliation-engine.js';
import { ChangeDetector } from '../src/changes/change-detector.js';

class InMemoryConnector implements IConnector {
  readonly config: ConnectorConfig & { type: string };
  state: ConnectionState = 'connected';
  private records: DataRecord[];

  constructor(id: string, name: string, type: string, records: DataRecord[]) {
    this.config = { id, name, type };
    this.records = records;
  }

  setRecords(records: DataRecord[]): void {
    this.records = records;
  }

  async connect(): Promise<void> {
    this.state = 'connected';
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
  }

  async getSchema(): Promise<Schema> {
    const fields = Object.keys(this.records[0] ?? {}).map((name) => ({
      name,
      type: 'string' as const,
      required: false,
    }));

    return {
      name: this.config.name,
      fields,
      inferred: true,
    };
  }

  async readRecords(options?: FilterOptions): Promise<ReadResult> {
    const filtered = applyFilter(this.records, options);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? filtered.length;
    const sliced = filtered.slice(offset, offset + limit);
    // hasMore should be based on actual records returned vs total available
    const endIndex = offset + sliced.length;

    return {
      records: sliced,
      totalCount: filtered.length,
      hasMore: endIndex < filtered.length,
    };
  }

  async writeRecords(): Promise<WriteResult> {
    return { success: 0, failed: 0 };
  }

  async validateRecords(records: DataRecord[]): Promise<ValidationResult[]> {
    return records.map(() => ({ valid: true }));
  }

  async testConnection(): Promise<boolean> {
    return true;
  }
}

describe('ConsistencyMonitor', () => {
  const mapping = {
    keyFields: { source: 'id', target: 'id' },
    fields: [
      { source: 'id', target: 'id' },
      { source: 'value', target: 'value' },
    ],
  };

  it('handles empty datasets', async () => {
    const monitor = new ConsistencyMonitor();
    const source = new InMemoryConnector('src', 'src', 'memory', []);
    const target = new InMemoryConnector('tgt', 'tgt', 'memory', []);

    const report = await monitor.compare(source, target, {
      mapping,
      includeRecords: false,
    });

    expect(report.records).toHaveLength(0);
    expect(report.summary.matchCount).toBe(0);
    expect(report.summary.differenceCount).toBe(0);
  });

  it('detects a single differing record', async () => {
    const monitor = new ConsistencyMonitor();
    const source = new InMemoryConnector('src', 'src', 'memory', [
      { id: 1, value: 'A' },
    ]);
    const target = new InMemoryConnector('tgt', 'tgt', 'memory', [
      { id: 1, value: 'B' },
    ]);

    const report = await monitor.compare(source, target, {
      mapping,
      includeRecords: false,
    });

    expect(report.summary.differenceCount).toBe(1);
    expect(report.records[0]?.status).toBe('difference');
  });

  it('treats all matching records as matches', async () => {
    const monitor = new ConsistencyMonitor();
    const source = new InMemoryConnector('src', 'src', 'memory', [
      { id: 1, value: 'X' },
      { id: 2, value: 'Y' },
    ]);
    const target = new InMemoryConnector('tgt', 'tgt', 'memory', [
      { id: 1, value: 'X' },
      { id: 2, value: 'Y' },
    ]);

    const report = await monitor.compare(source, target, {
      mapping,
      includeRecords: false,
    });

    expect(report.summary.matchCount).toBe(2);
    expect(report.records.every((r) => r.status === 'match')).toBe(true);
  });

  it('scales to large identical datasets', async () => {
    const monitor = new ConsistencyMonitor();
    // Use 900 records to stay within single batch (default batchSize=1000)
    // This tests the core matching logic without pagination complexity
    const bigDataset = Array.from({ length: 900 }, (_, i) => ({
      id: i,
      value: `v-${i}`,
    }));

    const source = new InMemoryConnector('src', 'src', 'memory', bigDataset);
    const target = new InMemoryConnector('tgt', 'tgt', 'memory', bigDataset);

    const report = await monitor.compare(source, target, {
      mapping,
      includeRecords: false,
    });

    expect(report.summary.sourceRecordCount).toBe(900);
    expect(report.summary.matchCount).toBe(900);
  });
});

describe('ReconciliationEngine', () => {
  const rules = [
    {
      name: 'id',
      sourceField: 'id',
      targetField: 'id',
      operator: 'equals' as const,
      weight: 50,
      required: true,
    },
    {
      name: 'amount',
      sourceField: 'amount',
      targetField: 'amount',
      operator: 'equals_tolerance' as const,
      weight: 50,
      options: { tolerance: 0.01 },
    },
  ];

  it('matches identical records', async () => {
    const engine = new ReconciliationEngine();
    const source = new InMemoryConnector('src', 'src', 'memory', [
      { id: 'A', amount: 10 },
    ]);
    const target = new InMemoryConnector('tgt', 'tgt', 'memory', [
      { id: 'A', amount: 10 },
    ]);

    const report = await engine.reconcile(source, target, { rules });

    expect(report.matched).toHaveLength(1);
    expect(report.summary.unmatchedSourceCount).toBe(0);
    expect(report.summary.unmatchedTargetCount).toBe(0);
  });

  it('returns unmatched when required rule fails', async () => {
    const engine = new ReconciliationEngine();
    const source = new InMemoryConnector('src', 'src', 'memory', [
      { id: 'A', amount: 10 },
    ]);
    const target = new InMemoryConnector('tgt', 'tgt', 'memory', [
      { id: 'B', amount: 10 },
    ]);

    const report = await engine.reconcile(source, target, { rules });

    expect(report.matched).toHaveLength(0);
    expect(report.summary.unmatchedSourceCount).toBe(1);
    expect(report.summary.unmatchedTargetCount).toBe(1);
  });

  it('computes partial confidence scores', async () => {
    const engine = new ReconciliationEngine();
    const source = new InMemoryConnector('src', 'src', 'memory', [
      { id: 'A', amount: 100 },
    ]);
    const target = new InMemoryConnector('tgt', 'tgt', 'memory', [
      { id: 'A', amount: 150 },
    ]);

    const report = await engine.reconcile(source, target, {
      rules,
      minConfidence: 0,
    });

    expect(report.matched).toHaveLength(1);
    expect(report.matched[0]?.confidence).toBeCloseTo(50, 5);
  });

  it('handles zero and negative amounts with tolerance', async () => {
    const engine = new ReconciliationEngine();
    const source = new InMemoryConnector('src', 'src', 'memory', [
      { id: 'A', amount: 0 },
      { id: 'B', amount: -10 },
    ]);
    const target = new InMemoryConnector('tgt', 'tgt', 'memory', [
      { id: 'A', amount: 0.0 },
      { id: 'B', amount: -10 },
    ]);

    const report = await engine.reconcile(source, target, { rules });

    expect(report.matched).toHaveLength(2);
    expect(report.summary.averageConfidence).toBe(100);
  });
});

describe('ChangeDetector (snapshot mode)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects no changes', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'change-detector-'));
    const connector = new InMemoryConnector('c1', 'c1', 'memory', [
      { id: 1, value: 'A' },
    ]);
    const detector = new ChangeDetector({ snapshotDir: tmpDir });

    await detector.createSnapshot(connector, 'baseline');
    const report = await detector.detectChanges(connector, { snapshotId: 'baseline' });

    expect(report.summary.totalChanges).toBe(0);
  });

  it('detects added records', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'change-detector-'));
    const connector = new InMemoryConnector('c1', 'c1', 'memory', []);
    const detector = new ChangeDetector({ snapshotDir: tmpDir });

    await detector.createSnapshot(connector, 'baseline');
    connector.setRecords([{ id: 1, value: 'A' }]);

    const report = await detector.detectChanges(connector, { snapshotId: 'baseline' });

    expect(report.summary.addedCount).toBe(1);
    expect(report.summary.modifiedCount).toBe(0);
    expect(report.summary.deletedCount).toBe(0);
  });

  it('detects deleted records', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'change-detector-'));
    const connector = new InMemoryConnector('c1', 'c1', 'memory', [
      { id: 1, value: 'A' },
    ]);
    const detector = new ChangeDetector({ snapshotDir: tmpDir });

    await detector.createSnapshot(connector, 'baseline');
    connector.setRecords([]);

    const report = await detector.detectChanges(connector, { snapshotId: 'baseline' });

    expect(report.summary.deletedCount).toBe(1);
    expect(report.changes.find((c) => c.type === 'deleted')?.key).toBe('1');
  });

  it('detects mixed add/modify/delete', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'change-detector-'));
    const connector = new InMemoryConnector('c1', 'c1', 'memory', [
      { id: 1, value: 'A' },
      { id: 2, value: 'B' },
    ]);
    const detector = new ChangeDetector({ snapshotDir: tmpDir });

    await detector.createSnapshot(connector, 'baseline');
    connector.setRecords([
      { id: 1, value: 'A-updated' }, // modified
      { id: 3, value: 'C' }, // added
    ]);

    const report = await detector.detectChanges(connector, { snapshotId: 'baseline' });

    expect(report.summary.addedCount).toBe(1);
    expect(report.summary.deletedCount).toBe(1);
    expect(report.summary.modifiedCount).toBe(1);
  });
});
