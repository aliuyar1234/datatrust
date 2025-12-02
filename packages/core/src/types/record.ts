/**
 * Record types for data exchange between connectors
 */

/** Generic record type - a row of data */
export type Record = {
  [key: string]: unknown;
};

/** Result of a read operation */
export interface ReadResult {
  /** The retrieved records */
  records: Record[];
  /** Total count (if available, for pagination) */
  totalCount?: number;
  /** Whether more records exist beyond the current page */
  hasMore?: boolean;
  /** Cursor for next page (if supported) */
  nextCursor?: string;
}

/** Result of a write operation */
export interface WriteResult {
  /** Number of records successfully written */
  success: number;
  /** Number of records that failed */
  failed: number;
  /** Details about failures */
  errors?: WriteError[];
  /** IDs of created/updated records (if available) */
  ids?: (string | number)[];
}

export interface WriteError {
  /** Index of the failed record in the input array */
  index: number;
  /** Error message */
  message: string;
  /** The record that failed (for debugging) */
  record?: Record;
}

/** Validation result for a single record */
export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}
