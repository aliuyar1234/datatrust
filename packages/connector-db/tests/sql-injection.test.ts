import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConnectorError } from '@datatrust/core';

const pgQueries: { sql: string; params?: unknown[] }[] = [];
const mysqlQueries: { sql: string; params?: unknown[] }[] = [];

vi.mock('pg', () => {
  class MockClient {
    release = vi.fn();
  }
  class MockPool {
    connect = vi.fn(async () => new MockClient());
    query = vi.fn(async (sql: string, params?: unknown[]) => {
      // Return column info for getColumns query
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { name: 'id', data_type: 'integer', is_nullable: false, column_default: null, is_primary_key: true },
            { name: 'amount', data_type: 'numeric', is_nullable: true, column_default: null, is_primary_key: false },
            { name: 'total', data_type: 'numeric', is_nullable: true, column_default: null, is_primary_key: false },
          ],
          rowCount: 3,
        };
      }
      pgQueries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    });
    end = vi.fn(async () => {});
  }
  return { default: { Pool: MockPool }, Pool: MockPool };
});

vi.mock('mysql2/promise', () => {
  class MockPool {
    execute = vi.fn(async (sql: string, params?: unknown[]) => {
      // Return column info for getColumns query
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return [[
          { name: 'id', data_type: 'int', is_nullable: 0, column_default: null, is_primary_key: 1 },
          { name: 'amount', data_type: 'decimal', is_nullable: 1, column_default: null, is_primary_key: 0 },
          { name: 'total', data_type: 'decimal', is_nullable: 1, column_default: null, is_primary_key: 0 },
        ], []];
      }
      mysqlQueries.push({ sql, params });
      return [[], []];
    });
    getConnection = vi.fn(async () => ({ release: vi.fn() }));
    end = vi.fn(async () => {});
  }
  return { default: { createPool: () => new MockPool() } };
});

// Imports after mocks
import { PostgresClient } from '../src/postgresql/client.js';
import { MySQLClient } from '../src/mysql/client.js';

describe('SQL identifier validation', () => {
  beforeEach(() => {
    pgQueries.length = 0;
    mysqlQueries.length = 0;
  });

  it('rejects malicious column names in PostgreSQL queries', async () => {
    const client = new PostgresClient({});
    await expect(
      client.select('invoices', {
        where: [{ column: 'id;DROP TABLE users;', op: 'eq', value: 1 }],
      })
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(pgQueries).toHaveLength(0);
  });

  it('allows safe PostgreSQL queries and parameterization', async () => {
    const client = new PostgresClient({});
    await client.select('invoices', {
      columns: ['id', 'amount'],
      where: [{ column: 'id', op: 'eq', value: 1 }],
      orderBy: [{ column: 'amount', direction: 'desc' }],
      limit: 10,
      offset: 0,
    });

    expect(pgQueries).toHaveLength(1);
    const { sql, params } = pgQueries[0]!;
    expect(sql).toContain('"id" = $1');
    expect(params).toEqual([1]);
  });

  it('rejects malicious column names in PostgreSQL insert/update/delete', async () => {
    const client = new PostgresClient({});

    await expect(
      client.insert(
        'invoices',
        { 'id;DROP TABLE users;': 1 },
        { schema: 'public', returning: ['id'] }
      )
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(pgQueries).toHaveLength(0);

    await expect(
      client.update(
        'invoices',
        { amount: 10 },
        [{ column: 'id;DROP TABLE users;', value: 1 }],
        { schema: 'public' }
      )
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(pgQueries).toHaveLength(0);

    await expect(
      client.delete(
        'invoices',
        [{ column: 'id;DROP TABLE users;', value: 1 }],
        { schema: 'public' }
      )
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(pgQueries).toHaveLength(0);
  });

  it('rejects malicious column names in MySQL queries', async () => {
    const client = new MySQLClient({});
    await expect(
      client.select('orders', {
        where: [{ column: 'total;DELETE FROM audit', op: 'eq', value: 1 }],
      })
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(mysqlQueries).toHaveLength(0);
  });

  it('allows safe MySQL queries and parameterization', async () => {
    const client = new MySQLClient({});
    await client.select('orders', {
      columns: ['id', 'total'],
      where: [{ column: 'id', op: 'eq', value: 99 }],
      orderBy: [{ column: 'total', direction: 'asc' }],
      limit: 5,
    });

    expect(mysqlQueries).toHaveLength(1);
    const { sql, params } = mysqlQueries[0]!;
    expect(sql).toContain('`id` = ?');
    expect(params).toEqual([99]);
  });

  it('rejects malicious column names in MySQL insert/update/delete', async () => {
    const client = new MySQLClient({});

    await expect(
      client.insert('orders', { 'id;DROP TABLE users;': 1 })
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(mysqlQueries).toHaveLength(0);

    await expect(
      client.update('orders', { total: 10 }, [{ column: 'id;DROP', value: 1 }])
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(mysqlQueries).toHaveLength(0);

    await expect(
      client.delete('orders', [{ column: 'id;DROP', value: 1 }])
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(mysqlQueries).toHaveLength(0);
  });
});
