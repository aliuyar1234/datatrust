/**
 * Schema types for describing data structures across connectors
 */

export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'array'
  | 'object';

export interface FieldDefinition {
  name: string;
  type: FieldType;
  required: boolean;
  description?: string;
  /** For array types: the type of array elements */
  items?: FieldType;
  /** For object types: nested field definitions */
  properties?: FieldDefinition[];
  /** Example value for documentation */
  example?: unknown;
}

export interface Schema {
  /** Unique identifier for this schema */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Field definitions */
  fields: FieldDefinition[];
  /** Primary key field name(s) */
  primaryKey?: string | string[];
  /** Whether the schema was auto-inferred or manually defined */
  inferred: boolean;
}
