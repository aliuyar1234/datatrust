/**
 * Field Mapping Types
 *
 * Configuration for mapping fields between source and target connectors.
 */

/** Built-in field transformations */
export type FieldTransform =
  | 'lowercase'
  | 'uppercase'
  | 'trim'
  | 'normalizeWhitespace'
  | 'parseDate'
  | 'parseNumber'
  | 'toString';

/** Single field mapping definition */
export interface FieldMapping {
  /** Field name in the source connector */
  source: string;
  /** Field name in the target connector */
  target: string;
  /** Transformation to apply before comparison */
  transform?: FieldTransform;
  /** Custom comparator name (default: exact) */
  comparator?: string;
}

/** Key field configuration for record matching */
export interface KeyFieldConfig {
  /** Field name(s) in source connector */
  source: string | string[];
  /** Field name(s) in target connector */
  target: string | string[];
}

/** Complete mapping configuration */
export interface MappingConfig {
  /** Field mappings for comparison */
  fields: FieldMapping[];
  /** Key field(s) for record matching (overrides schema primaryKey) */
  keyFields?: KeyFieldConfig;
  /** Ignore fields not explicitly mapped (default: false) */
  strictMapping?: boolean;
}
