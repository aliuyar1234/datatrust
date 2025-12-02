/**
 * Formatter Utilities
 *
 * Shared utility functions for report formatting.
 */

/**
 * Format a record key for display
 */
export function formatKey(key: string | Record<string, unknown>): string {
  return typeof key === 'string' ? key : JSON.stringify(key);
}
