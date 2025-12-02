/**
 * PostgreSQL Client
 *
 * Wrapper around pg for database operations.
 * Uses modern pg v8.13+ with native ESM support.
 */

import pg from 'pg';
import { ConnectorError } from '@datatrust/core';

const { Pool } = pg;

export interface PostgresClientConfig {
  /** Connection string or individual params */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** SSL mode */
  ssl?: boolean | { rejectUnauthorized?: boolean };
  /** Connection pool size */
  max?: number;
}

export interface PostgresColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  isPrimaryKey: boolean;
}

export interface PostgresQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/** Valid SQL identifier pattern (alphanumeric + underscore, must start with letter/underscore) */
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate that a string is a safe SQL identifier
 */
function validateIdentifier(name: string, type: string): void {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new ConnectorError({
      code: 'READ_FAILED',
      message: `Invalid ${type} name: "${name}". Must be alphanumeric with underscores, starting with a letter or underscore.`,
      suggestion: `Use only valid SQL identifiers for ${type} names.`,
    });
  }
}

/**
 * Validate column names against a whitelist from schema
 */
function validateColumns(columns: string[], allowedColumns: Set<string>, context: string): void {
  for (const col of columns) {
    if (!allowedColumns.has(col)) {
      throw new ConnectorError({
        code: 'READ_FAILED',
        message: `Invalid column "${col}" in ${context}. Column does not exist in table schema.`,
        suggestion: `Valid columns: ${Array.from(allowedColumns).join(', ')}`,
      });
    }
  }
}

export class PostgresClient {
  private pool: pg.Pool;
  private connected = false;
  private columnCache = new Map<string, Set<string>>();

  constructor(config: PostgresClientConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      host: config.host,
      port: config.port ?? 5432,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      max: config.max ?? 10,
    });
  }

  /**
   * Test connection
   */
  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.release();
      this.connected = true;
    } catch (error) {
      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `PostgreSQL connection failed: ${(error as Error).message}`,
        suggestion: 'Check host, port, database, user, and password.',
      });
    }
  }

  /**
   * Close all connections
   */
  async disconnect(): Promise<void> {
    await this.pool.end();
    this.connected = false;
  }

  /**
   * Execute a query
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<PostgresQueryResult<T>> {
    try {
      const result = await this.pool.query(sql, params);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? 0,
      };
    } catch (error) {
      throw new ConnectorError({
        code: 'READ_FAILED',
        message: `Query failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Get columns for a table
   */
  async getColumns(table: string, schema = 'public'): Promise<PostgresColumn[]> {
    // Validate identifiers to prevent SQL injection
    validateIdentifier(schema, 'schema');
    validateIdentifier(table, 'table');

    const sql = `
      SELECT
        c.column_name as name,
        c.data_type as data_type,
        c.is_nullable = 'YES' as is_nullable,
        c.column_default,
        COALESCE(
          (SELECT true FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_schema = c.table_schema
             AND tc.table_name = c.table_name
             AND tc.constraint_type = 'PRIMARY KEY'
             AND kcu.column_name = c.column_name
           LIMIT 1), false
        ) as is_primary_key
      FROM information_schema.columns c
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
    `;

    const result = await this.query<{
      name: string;
      data_type: string;
      is_nullable: boolean;
      column_default: string | null;
      is_primary_key: boolean;
    }>(sql, [schema, table]);

    return result.rows.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      isNullable: row.is_nullable,
      columnDefault: row.column_default,
      isPrimaryKey: row.is_primary_key,
    }));
  }

  /**
   * Get list of tables
   */
  async getTables(schema = 'public'): Promise<string[]> {
    // Validate schema to prevent SQL injection
    validateIdentifier(schema, 'schema');

    const sql = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    const result = await this.query<{ table_name: string }>(sql, [schema]);
    return result.rows.map((row) => row.table_name);
  }

  /**
   * Get allowed columns for a table (cached)
   */
  private async getAllowedColumns(table: string, schema: string): Promise<Set<string>> {
    const cacheKey = `${schema}.${table}`;
    if (this.columnCache.has(cacheKey)) {
      return this.columnCache.get(cacheKey)!;
    }

    const columns = await this.getColumns(table, schema);
    const columnSet = new Set(columns.map((c) => c.name));
    this.columnCache.set(cacheKey, columnSet);
    return columnSet;
  }

  /**
   * Clear the column cache (call after schema changes)
   */
  clearColumnCache(): void {
    this.columnCache.clear();
  }

  /**
   * Select records with filters
   */
  async select(
    table: string,
    options: {
      columns?: string[];
      where?: { column: string; op: string; value: unknown }[];
      orderBy?: { column: string; direction: 'asc' | 'desc' }[];
      limit?: number;
      offset?: number;
      schema?: string;
    } = {}
  ): Promise<Record<string, unknown>[]> {
    const schema = options.schema ?? 'public';

    // Validate table and schema names
    validateIdentifier(table, 'table');
    validateIdentifier(schema, 'schema');

    // Get allowed columns from schema
    const allowedColumns = await this.getAllowedColumns(table, schema);

    // Validate column names if specified
    if (options.columns?.length) {
      validateColumns(options.columns, allowedColumns, 'SELECT');
    }

    // Validate WHERE columns
    if (options.where?.length) {
      const whereColumns = options.where.map((w) => w.column);
      validateColumns(whereColumns, allowedColumns, 'WHERE');
    }

    // Validate ORDER BY columns
    if (options.orderBy?.length) {
      const orderColumns = options.orderBy.map((o) => o.column);
      validateColumns(orderColumns, allowedColumns, 'ORDER BY');
    }

    const columns = options.columns?.length ? options.columns.map((c) => `"${c}"`).join(', ') : '*';
    const params: unknown[] = [];
    let paramIndex = 1;

    let sql = `SELECT ${columns} FROM "${schema}"."${table}"`;

    if (options.where?.length) {
      const whereClauses = options.where.map((w) => {
        const op = this.mapOperator(w.op);
        if (w.op === 'in' && Array.isArray(w.value)) {
          const placeholders = w.value.map(() => `$${paramIndex++}`).join(', ');
          params.push(...w.value);
          return `"${w.column}" ${op} (${placeholders})`;
        }
        params.push(w.value);
        return `"${w.column}" ${op} $${paramIndex++}`;
      });
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    if (options.orderBy?.length) {
      const orderClauses = options.orderBy.map((o) => `"${o.column}" ${o.direction.toUpperCase()}`);
      sql += ` ORDER BY ${orderClauses.join(', ')}`;
    }

    if (options.limit !== undefined) {
      sql += ` LIMIT ${options.limit}`;
    }

    if (options.offset !== undefined) {
      sql += ` OFFSET ${options.offset}`;
    }

    const result = await this.query<Record<string, unknown>>(sql, params);
    return result.rows;
  }

  /**
   * Count records
   */
  async count(
    table: string,
    options: {
      where?: { column: string; op: string; value: unknown }[];
      schema?: string;
    } = {}
  ): Promise<number> {
    const schema = options.schema ?? 'public';

    // Validate table and schema names
    validateIdentifier(table, 'table');
    validateIdentifier(schema, 'schema');

    // Validate WHERE columns if provided
    if (options.where?.length) {
      const allowedColumns = await this.getAllowedColumns(table, schema);
      const whereColumns = options.where.map((w) => w.column);
      validateColumns(whereColumns, allowedColumns, 'WHERE');
    }

    const params: unknown[] = [];
    let paramIndex = 1;

    let sql = `SELECT COUNT(*) as count FROM "${schema}"."${table}"`;

    if (options.where?.length) {
      const whereClauses = options.where.map((w) => {
        const op = this.mapOperator(w.op);
        if (w.op === 'in' && Array.isArray(w.value)) {
          const placeholders = w.value.map(() => `$${paramIndex++}`).join(', ');
          params.push(...w.value);
          return `"${w.column}" ${op} (${placeholders})`;
        }
        params.push(w.value);
        return `"${w.column}" ${op} $${paramIndex++}`;
      });
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const result = await this.query<{ count: string }>(sql, params);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Insert a record
   */
  async insert(
    table: string,
    values: Record<string, unknown>,
    options: { schema?: string; returning?: string[] } = {}
  ): Promise<Record<string, unknown> | null> {
    const schema = options.schema ?? 'public';
    const columns = Object.keys(values);
    const params = Object.values(values);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    let sql = `INSERT INTO "${schema}"."${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`;

    if (options.returning?.length) {
      sql += ` RETURNING ${options.returning.map((c) => `"${c}"`).join(', ')}`;
    }

    const result = await this.query<Record<string, unknown>>(sql, params);
    return result.rows[0] ?? null;
  }

  /**
   * Update records
   */
  async update(
    table: string,
    values: Record<string, unknown>,
    where: { column: string; value: unknown }[],
    options: { schema?: string } = {}
  ): Promise<number> {
    const schema = options.schema ?? 'public';
    const setCols = Object.keys(values);
    const params: unknown[] = [...Object.values(values)];
    let paramIndex = setCols.length + 1;

    const setClause = setCols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
    const whereClause = where
      .map((w) => {
        params.push(w.value);
        return `"${w.column}" = $${paramIndex++}`;
      })
      .join(' AND ');

    const sql = `UPDATE "${schema}"."${table}" SET ${setClause} WHERE ${whereClause}`;

    const result = await this.query(sql, params);
    return result.rowCount;
  }

  /**
   * Delete records
   */
  async delete(
    table: string,
    where: { column: string; value: unknown }[],
    options: { schema?: string } = {}
  ): Promise<number> {
    const schema = options.schema ?? 'public';
    const params: unknown[] = [];

    const whereClause = where
      .map((w, i) => {
        params.push(w.value);
        return `"${w.column}" = $${i + 1}`;
      })
      .join(' AND ');

    const sql = `DELETE FROM "${schema}"."${table}" WHERE ${whereClause}`;

    const result = await this.query(sql, params);
    return result.rowCount;
  }

  /**
   * Map our operators to SQL
   */
  private mapOperator(op: string): string {
    const map: Record<string, string> = {
      eq: '=',
      neq: '!=',
      gt: '>',
      lt: '<',
      gte: '>=',
      lte: '<=',
      contains: 'ILIKE',
      in: 'IN',
    };
    return map[op] ?? '=';
  }
}
