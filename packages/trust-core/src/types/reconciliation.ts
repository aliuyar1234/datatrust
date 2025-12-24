/**
 * Reconciliation Types
 *
 * Types for matching and reconciling records between data sources.
 */

import type { ConnectorInfo } from './comparison.js';

/** Matching rule operators */
export type RuleOperator =
  | 'equals'           // Exact match
  | 'equals_tolerance' // Numeric match with tolerance
  | 'contains'         // String contains
  | 'regex'            // Regex pattern match
  | 'similarity'       // Fuzzy string similarity
  | 'date_range';      // Date within range

/**
 * Configuration for a matching rule
 */
export interface MatchingRule {
  /** Rule name for identification */
  name: string;
  /** Field name in source records */
  sourceField: string;
  /** Field name in target records */
  targetField: string;
  /** Comparison operator */
  operator: RuleOperator;
  /** Operator-specific options */
  options?: {
    /** Tolerance for equals_tolerance (e.g., 0.01 for cents) */
    tolerance?: number;
    /** Days range for date_range (e.g., 3 means ±3 days) */
    dateRangeDays?: number;
    /** Case sensitivity for string operators */
    caseSensitive?: boolean;
    /**
     * For operator=regex: when true, interpret target values as raw regular expressions.
     * Default: false (treat as a literal substring match to avoid ReDoS).
     */
    unsafeRegex?: boolean;
    /** For operator=similarity: algorithm to use (default: "jaro_winkler") */
    similarityAlgorithm?:
      | 'levenshtein'
      | 'jaro'
      | 'jaro_winkler'
      | 'dice_sorensen'
      | 'jaccard'
      | 'cologne_phonetic'
      | 'soundex';
    /** For operator=similarity: threshold between 0 and 1 (default: 0.85) */
    similarityThreshold?: number;
    /** For dice_sorensen/jaccard: n-gram size (default: 2) */
    ngramSize?: number;
    /** For jaro_winkler: prefix scale (default: 0.1, max: 0.25) */
    prefixScale?: number;
  };
  /** Weight for confidence score calculation (1-100) */
  weight: number;
  /** If true, rule must match for a valid match */
  required?: boolean;
}

/**
 * Result of a single match between source and target records
 */
export interface MatchResult {
  /** The matched source record */
  sourceRecord: Record<string, unknown>;
  /** The matched target record */
  targetRecord: Record<string, unknown>;
  /** Key of the source record */
  sourceKey: string;
  /** Key of the target record */
  targetKey: string;
  /** Confidence score (0-100) */
  confidence: number;
  /** Names of rules that matched */
  matchedRules: string[];
  /** Names of rules that failed */
  failedRules: string[];
}

/**
 * Unmatched record reference
 */
export interface UnmatchedRecord {
  /** The record data */
  record: Record<string, unknown>;
  /** The record key */
  key: string;
}

/**
 * Summary statistics for reconciliation
 */
export interface ReconciliationSummary {
  /** Number of source records processed */
  sourceCount: number;
  /** Number of target records processed */
  targetCount: number;
  /** Number of matched pairs */
  matchedCount: number;
  /** Number of unmatched source records */
  unmatchedSourceCount: number;
  /** Number of unmatched target records */
  unmatchedTargetCount: number;
  /** Average confidence of matches */
  averageConfidence: number;
}

/**
 * Complete reconciliation report
 */
export interface ReconciliationReport {
  /** Unique report ID */
  id: string;
  /** Report generation timestamp */
  timestamp: Date;
  /** Source connector info */
  source: ConnectorInfo;
  /** Target connector info */
  target: ConnectorInfo;
  /** Rules used for matching */
  rules: MatchingRule[];
  /** Summary statistics */
  summary: ReconciliationSummary;
  /** Successfully matched record pairs */
  matched: MatchResult[];
  /** Unmatched source records */
  unmatchedSource: UnmatchedRecord[];
  /** Unmatched target records */
  unmatchedTarget: UnmatchedRecord[];
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Options for reconciliation
 */
export interface BlockingOptions {
  /**
   * Blocking mode:
   * - auto: use safe blocking derived from required equals rules when possible
   * - configured: use sourceField/targetField + algorithm for blocking (falls back to full scan if no candidates)
   * - off: disable blocking (full scan)
   */
  mode?: 'auto' | 'configured' | 'off';
  /** Source field used for blocking in configured mode */
  sourceField?: string;
  /** Target field used for blocking in configured mode */
  targetField?: string;
  /** Blocking algorithm for configured mode (default: exact) */
  algorithm?: 'exact' | 'prefix' | 'cologne_phonetic' | 'soundex';
  /** Prefix length for algorithm=prefix (default: 4) */
  prefixLength?: number;
}

export interface ReconciliationOptions {
  /** Matching rules to apply */
  rules: MatchingRule[];
  /** Key field in source records (default: 'id') */
  sourceKeyField?: string;
  /** Key field in target records (default: 'id') */
  targetKeyField?: string;
  /** Minimum confidence for a valid match (default: 50) */
  minConfidence?: number;
  /** Maximum records to process */
  maxRecords?: number;
  /** Optional blocking configuration to reduce candidate comparisons */
  blocking?: BlockingOptions;
}
