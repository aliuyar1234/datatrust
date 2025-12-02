/**
 * MySQL Client
 *
 * Wrapper around mysql2/promise for database operations.
 * Uses mysql2 v3.11+ with native ESM and Promise support.
 */

import mysql from 'mysql2/promise';
import { ConnectorError } from '@datatrust/core';

export interface MySQLClientConfig {
  /** Connection string (alternative to individual params) */
  uri?: string;
  /** Database host */
  host?: string;
  /** Database port */
  port?: number;
  /** Database name */
  database?: string;
  /** Username */
  user?: string;
  /** Password */
  password?: string;
  /** SSL configuration */
  ssl?: boolean | { rejectUnauthorized?: boolean };
  /** Connection pool size */
  connectionLimit?: number;
}

export interface MySQLColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  isPrimaryKey: boolean;
}

export interface MySQLQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  insertId?: number;
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

export class MySQLClient {
  private pool: mysql.Pool;
  private config: MySQLClientConfig;
  private columnCache = new Map<string, Set<string>>();

  constructor(config: MySQLClientConfig) {
    this.config = config;
    this.pool = mysql.createPool({
      uri: config.uri,
      host: config.host,
      port: config.port ?? 3306,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
      connectionLimit: config.connectionLimit ?? 10,
      waitForConnections: true,
    });
  }

  /**
   * Test connection
   */
  async connect(): Promise<void> {
    try {
      const connection = await this.pool.getConnection();
      connection.release();
    } catch (error) {
      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `MySQL connection failed: ${(error as Error).message}`,
        suggestion: 'Check host, port, database, user, and password.',
      });
    }
  }

  /**
   * Close all connections
   */
  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Execute a query
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<MySQLQueryResult<T>> {
    try {
      const [rows, fields] = await this.pool.execute(sql, params);

      // Handle SELECT queries
      if (Array.isArray(rows)) {
        return {
          rows: rows as T[],
          rowCount: rows.length,
        };
      }

      // Handle INSERT/UPDATE/DELETE
      const result = rows as mysql.ResultSetHeader;
      return {
        rows: [] as T[],
        rowCount: result.affectedRows,
        insertId: result.insertId,
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
  async getColumns(table: string): Promise<MySQLColumn[]> {
    // Validate table name to prevent SQL injection
    validateIdentifier(table, 'table');

    const sql = `
      SELECT
        COLUMN_NAME as name,
        DATA_TYPE as data_type,
        IS_NULLABLE = 'YES' as is_nullable,
        COLUMN_DEFAULT as column_default,
        COLUMN_KEY = 'PRI' as is_primary_key
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;

    const result = await this.query<{
      name: string;
      data_type: string;
      is_nullable: number;
      column_default: string | null;
      is_primary_key: number;
    }>(sql, [table]);

    return result.rows.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      isNullable: row.is_nullable === 1,
      columnDefault: row.column_default,
      isPrimaryKey: row.is_primary_key === 1,
    }));
  }

  /**
   * Get list of tables
   */
  async getTables(): Promise<string[]> {
    const sql = `
      SELECT TABLE_NAME as table_name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `;

    const result = await this.query<{ table_name: string }>(sql);
    return result.rows.map((row) => row.table_name);
  }

  /**
   * Get allowed columns for a table (cached)
   */
  private async getAllowedColumns(table: string): Promise<Set<string>> {
    if (this.columnCache.has(table)) {
      return this.columnCache.get(table)!;
    }

    const columns = await this.getColumns(table);
    const columnSet = new Set(columns.map((c) => c.name));
    this.columnCache.set(table, columnSet);
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
    } = {}
  ): Promise<Record<string, unknown>[]> {
    // Validate table name
    validateIdentifier(table, 'table');

    // Get allowed columns from schema
    const allowedColumns = await this.getAllowedColumns(table);

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

    const columns = options.columns?.length ? options.columns.map((c) => `\`${c}\``).join(', ') : '*';
    const params: unknown[] = [];

    let sql = `SELECT ${columns} FROM \`${table}\``;

    if (options.where?.length) {
      const whereClauses = options.where.map((w) => {
        const op = this.mapOperator(w.op);
        if (w.op === 'in' && Array.isArray(w.value)) {
          const placeholders = w.value.map(() => '?').join(', ');
          params.push(...w.value);
          return `\`${w.column}\` ${op} (${placeholders})`;
        }
        params.push(w.value);
        return `\`${w.column}\` ${op} ?`;
      });
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    if (options.orderBy?.length) {
      const orderClauses = options.orderBy.map((o) => `\`${o.column}\` ${o.direction.toUpperCase()}`);
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
    } = {}
  ): Promise<number> {
    // Validate table name
    validateIdentifier(table, 'table');

    // Validate WHERE columns if provided
    if (options.where?.length) {
      const allowedColumns = await this.getAllowedColumns(table);
      const whereColumns = options.where.map((w) => w.column);
      validateColumns(whereColumns, allowedColumns, 'WHERE');
    }

    const params: unknown[] = [];

    let sql = `SELECT COUNT(*) as count FROM \`${table}\``;

    if (options.where?.length) {
      const whereClauses = options.where.map((w) => {
        const op = this.mapOperator(w.op);
        if (w.op === 'in' && Array.isArray(w.value)) {
          const placeholders = w.value.map(() => '?').join(', ');
          params.push(...w.value);
          return `\`${w.column}\` ${op} (${placeholders})`;
        }
        params.push(w.value);
        return `\`${w.column}\` ${op} ?`;
      });
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const result = await this.query<{ count: number }>(sql, params);
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Insert a record
   */
  async insert(
    table: string,
    values: Record<string, unknown>
  ): Promise<number> {
    const columns = Object.keys(values);
    const params = Object.values(values);
    const placeholders = columns.map(() => '?').join(', ');

    const sql = `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders})`;

    const result = await this.query(sql, params);
    return result.insertId ?? 0;
  }

  /**
   * Update records
   */
  async update(
    table: string,
    values: Record<string, unknown>,
    where: { column: string; value: unknown }[]
  ): Promise<number> {
    const setCols = Object.keys(values);
    const params: unknown[] = [...Object.values(values)];

    const setClause = setCols.map((c) => `\`${c}\` = ?`).join(', ');
    const whereClause = where
      .map((w) => {
        params.push(w.value);
        return `\`${w.column}\` = ?`;
      })
      .join(' AND ');

    const sql = `UPDATE \`${table}\` SET ${setClause} WHERE ${whereClause}`;

    const result = await this.query(sql, params);
    return result.rowCount;
  }

  /**
   * Delete records
   */
  async delete(
    table: string,
    where: { column: string; value: unknown }[]
  ): Promise<number> {
    const params: unknown[] = [];

    const whereClause = where
      .map((w) => {
        params.push(w.value);
        return `\`${w.column}\` = ?`;
      })
      .join(' AND ');

    const sql = `DELETE FROM \`${table}\` WHERE ${whereClause}`;

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
      contains: 'LIKE',
      in: 'IN',
    };
    return map[op] ?? '=';
  }
}
