/**
 * Unified filter syntax for querying records across all connectors
 */

export type FilterOperator =
  | 'eq'       // equals
  | 'neq'      // not equals
  | 'gt'       // greater than
  | 'lt'       // less than
  | 'gte'      // greater than or equal
  | 'lte'      // less than or equal
  | 'contains' // string contains (case-insensitive)
  | 'in';      // value in array

export interface FilterCondition {
  field: string;
  op: FilterOperator;
  value: unknown;
}

export interface FilterOptions {
  /** Filter conditions (AND logic) */
  where?: FilterCondition[];
  /** Fields to return (empty = all) */
  select?: string[];
  /** Sort configuration */
  orderBy?: {
    field: string;
    direction: 'asc' | 'desc';
  }[];
  /** Pagination: number of records to skip (offset-based) */
  offset?: number;
  /** Pagination: max records to return */
  limit?: number;
  /** Pagination: cursor for cursor-based pagination (preferred over offset) */
  cursor?: string;
}

/**
 * Type guard to check if a value is a valid FilterOperator
 */
export function isFilterOperator(value: unknown): value is FilterOperator {
  return (
    typeof value === 'string' &&
    ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'].includes(value)
  );
}
