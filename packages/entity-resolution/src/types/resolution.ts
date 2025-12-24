/**
 * Entity Resolution Types
 */

import type { Record as DataRecord } from '@datatrust/core';
import type { FieldRole, PreprocessingStep } from './similarity.js';

/** Entity types supported for resolution */
export type EntityType = 'company' | 'person' | 'product' | 'invoice' | 'custom';

/** Configuration for entity resolution */
export interface EntityResolutionConfig {
  /** Type of entity being resolved */
  entityType: EntityType;

  /** Fields to use for matching */
  fields: EntityFieldConfig[];

  /** Blocking strategy to reduce comparisons */
  blocking: BlockingConfig;

  /** Confidence thresholds for match decisions */
  thresholds: MatchThresholds;

  /** LLM configuration for uncertain cases */
  llm?: LLMResolutionConfig;
}

/** Configuration for a matching field */
export interface EntityFieldConfig {
  /** Field name in source records */
  sourceField: string;

  /** Field name in target records */
  targetField: string;

  /** Role determines which similarity functions to apply */
  role: FieldRole;

  /** Weight in final score (0-1, weights should sum to 1) */
  weight: number;

  /** Preprocessing pipeline */
  preprocessing?: PreprocessingStep[];

  /** Whether this field is required for a match */
  required?: boolean;
}

/** Blocking configuration */
export interface BlockingConfig {
  /** Blocking strategy to use */
  strategy: BlockingStrategy;

  /** Fields to use for blocking key generation */
  blockingFields: string[];

  /** Strategy-specific options */
  options?: BlockingOptions;
}

/** Available blocking strategies */
export type BlockingStrategy =
  | 'sorted_neighborhood'
  | 'phonetic'
  | 'ngram'
  | 'lsh'
  | 'canopy'
  | 'none';  // No blocking (compare all pairs)

/** Blocking strategy options */
export interface BlockingOptions {
  /** Window size for sorted neighborhood */
  windowSize?: number;

  /** N-gram size for n-gram blocking */
  ngramSize?: number;

  /** Number of hash functions for LSH */
  numHashFunctions?: number;

  /** Number of bands for LSH */
  numBands?: number;
}

/** Match confidence thresholds */
export interface MatchThresholds {
  /** Above this: automatic match (default: 0.95) */
  definiteMatch: number;

  /** Above this: likely match, may use LLM (default: 0.70) */
  probableMatch: number;

  /** Above this: possible match, needs review (default: 0.50) */
  possibleMatch: number;
}

/** LLM configuration for entity resolution */
export interface LLMResolutionConfig {
  /** Whether to use LLM for uncertain cases */
  enabled: boolean;

  /** LLM provider to use */
  provider: 'claude' | 'openai' | 'deepseek';

  /** Model identifier */
  model?: string;

  /** API key (defaults to env variable) */
  apiKey?: string;

  /** Maximum cost budget for LLM calls */
  maxBudget?: {
    amount: number;
    currency: 'EUR' | 'USD';
  };
}

/** A candidate pair for comparison */
export interface CandidatePair {
  /** Source record */
  source: DataRecord;

  /** Target record */
  target: DataRecord;

  /** Pre-computed similarity score (from blocking/fast similarity) */
  preliminaryScore?: number;

  /** Which blocking strategy generated this pair */
  blockingSource?: BlockingStrategy;
}

/** Result of entity resolution */
export interface ResolutionResult {
  /** Matched pairs with confidence */
  matches: MatchResult[];

  /** Source records with no match found */
  unmatchedSource: DataRecord[];

  /** Target records not matched to any source */
  unmatchedTarget: DataRecord[];

  /** Statistics about the resolution */
  stats: ResolutionStats;
}

/** A single match result */
export interface MatchResult {
  /** Key of the source record */
  sourceKey: string;

  /** Key of the target record */
  targetKey: string;

  /** Source record data */
  sourceRecord: DataRecord;

  /** Target record data */
  targetRecord: DataRecord;

  /** Overall confidence score (0-1) */
  confidence: number;

  /** Classification of the match */
  classification: MatchClassification;

  /** How the confidence was determined */
  method: 'rule_based' | 'llm_reasoning' | 'hybrid';

  /** Detailed explanation of why these records match */
  explanation: MatchExplanation;
}

/** Match classification */
export type MatchClassification = 'definite' | 'probable' | 'possible' | 'no_match';

/** Detailed explanation of a match */
export interface MatchExplanation {
  /** Human-readable summary */
  summary: string;

  /** Field-level comparisons */
  fieldComparisons: FieldComparison[];

  /** Signals that supported the match */
  matchingSignals: string[];

  /** Signals that conflicted */
  conflictingSignals: string[];

  /** LLM reasoning if used */
  llmReasoning?: string;
}

/** Comparison result for a single field */
export interface FieldComparison {
  /** Field name */
  field: string;

  /** Source value */
  sourceValue: unknown;

  /** Target value */
  targetValue: unknown;

  /** Similarity score for this field */
  similarity: number;

  /** Algorithm used */
  algorithm: string;

  /** Whether this field supports the match */
  supports: boolean;
}

/** Statistics about a resolution run */
export interface ResolutionStats {
  /** Total source records processed */
  sourceCount: number;

  /** Total target records processed */
  targetCount: number;

  /** Total candidate pairs generated */
  candidatePairs: number;

  /** Number of matches found */
  matchCount: number;

  /** Breakdown by classification */
  byClassification: {
    definite: number;
    probable: number;
    possible: number;
  };

  /** Breakdown by method */
  byMethod: {
    ruleBased: number;
    llmReasoning: number;
    hybrid: number;
  };

  /** LLM usage stats if applicable */
  llmStats?: {
    callCount: number;
    tokensUsed: number;
    estimatedCost: number;
  };

  /** Processing time in milliseconds */
  processingTimeMs: number;
}
