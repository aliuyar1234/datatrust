/**
 * Filter utilities for applying filters to records in memory
 * Used by file-based connectors and for client-side filtering
 */

import type { FilterCondition, FilterOptions, Record } from '../types/index.js';

/**
 * Apply a single filter condition to a value
 */
function matchCondition(value: unknown, condition: FilterCondition): boolean {
  const { op, value: filterValue } = condition;

  switch (op) {
    case 'eq':
      return value === filterValue;

    case 'neq':
      return value !== filterValue;

    case 'gt':
      return typeof value === 'number' && typeof filterValue === 'number'
        ? value > filterValue
        : String(value) > String(filterValue);

    case 'lt':
      return typeof value === 'number' && typeof filterValue === 'number'
        ? value < filterValue
        : String(value) < String(filterValue);

    case 'gte':
      return typeof value === 'number' && typeof filterValue === 'number'
        ? value >= filterValue
        : String(value) >= String(filterValue);

    case 'lte':
      return typeof value === 'number' && typeof filterValue === 'number'
        ? value <= filterValue
        : String(value) <= String(filterValue);

    case 'contains':
      return String(value).toLowerCase().includes(String(filterValue).toLowerCase());

    case 'in':
      return Array.isArray(filterValue) && filterValue.includes(value);

    default:
      return false;
  }
}

/**
 * Check if a record matches all filter conditions
 */
function matchRecord(record: Record, conditions: FilterCondition[]): boolean {
  return conditions.every((condition) => {
    const value = record[condition.field];
    return matchCondition(value, condition);
  });
}

/**
 * Apply filter options to an array of records
 * Handles filtering, sorting, pagination, and field selection
 */
export function applyFilter(records: Record[], options?: FilterOptions): Record[] {
  if (!options) {
    return records;
  }

  let result = [...records];

  // Apply where conditions
  if (options.where && options.where.length > 0) {
    result = result.filter((record) => matchRecord(record, options.where!));
  }

  // Apply sorting
  if (options.orderBy && options.orderBy.length > 0) {
    result.sort((a, b) => {
      for (const { field, direction } of options.orderBy!) {
        const aVal = a[field];
        const bVal = b[field];

        let comparison: number;
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          comparison = aVal - bVal;
        } else {
          comparison = String(aVal ?? '').localeCompare(String(bVal ?? ''));
        }

        if (comparison !== 0) {
          return direction === 'desc' ? -comparison : comparison;
        }
      }
      return 0;
    });
  }

  // Apply pagination
  const offset = options.offset ?? 0;
  const limit = options.limit ?? result.length;
  result = result.slice(offset, offset + limit);

  // Apply field selection
  if (options.select && options.select.length > 0) {
    const selectedFields = new Set(options.select);
    result = result.map((record) => {
      const selected: Record = {};
      for (const field of selectedFields) {
        if (Object.prototype.hasOwnProperty.call(record, field)) {
          selected[field] = record[field];
        }
      }
      return selected;
    });
  }

  return result;
}

/**
 * Count records matching filter conditions (without pagination)
 */
export function countMatching(records: Record[], conditions?: FilterCondition[]): number {
  if (!conditions || conditions.length === 0) {
    return records.length;
  }
  return records.filter((record) => matchRecord(record, conditions)).length;
}
