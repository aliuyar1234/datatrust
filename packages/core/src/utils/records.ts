/**
 * Utility functions for working with records
 */

import type { Record } from '../types/index.js';

/**
 * Extract all unique field names from an array of records
 */
export function extractFieldNames(records: Record[]): string[] {
  const fields = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      fields.add(key);
    }
  }
  return Array.from(fields);
}
