/**
 * String Similarity Types
 */

/** Result of a similarity comparison */
export interface SimilarityResult {
  /** Similarity score between 0 (no match) and 1 (exact match) */
  score: number;

  /** Which algorithm produced this result */
  algorithm: SimilarityAlgorithm;

  /** Optional details about the comparison */
  details?: string;
}

/** Available similarity algorithms */
export type SimilarityAlgorithm =
  | 'levenshtein'
  | 'jaro'
  | 'jaro_winkler'
  | 'dice_sorensen'
  | 'jaccard'
  | 'ngram'
  | 'soundex'
  | 'metaphone'
  | 'cologne_phonetic'
  | 'composite';

/** Configuration for similarity calculation */
export interface SimilarityConfig {
  /** Which algorithm to use */
  algorithm: SimilarityAlgorithm;

  /** For n-gram: size of n-grams (default: 2) */
  ngramSize?: number;

  /** Whether to normalize strings before comparison */
  normalize?: boolean;

  /** Whether comparison is case-sensitive */
  caseSensitive?: boolean;
}

/** Result of a composite similarity calculation using multiple algorithms */
export interface CompositeSimilarityResult {
  /** Final aggregated score */
  score: number;

  /** Individual algorithm results */
  components: SimilarityResult[];

  /** How the score was calculated */
  aggregation: 'average' | 'weighted' | 'max' | 'min';
}

/** Configuration for field-specific similarity */
export interface FieldSimilarityConfig {
  /** Field role determines which algorithms to use */
  role: FieldRole;

  /** Weight of this field in overall matching (0-1) */
  weight: number;

  /** Preprocessing steps before comparison */
  preprocessing?: PreprocessingStep[];
}

/** Field roles for context-aware matching */
export type FieldRole =
  | 'company_name'
  | 'person_name'
  | 'email'
  | 'phone'
  | 'address'
  | 'identifier'  // VAT, Tax ID, etc.
  | 'numeric'
  | 'date'
  | 'free_text';

/** Preprocessing steps for string normalization */
export type PreprocessingStep =
  | 'lowercase'
  | 'uppercase'
  | 'trim'
  | 'remove_whitespace'
  | 'remove_punctuation'
  | 'normalize_umlauts'    // ä→ae, ö→oe, ü→ue, ß→ss
  | 'expand_umlauts'       // ae→ä, oe→ö, ue→ü
  | 'remove_legal_forms'   // Remove GmbH, AG, etc.
  | 'normalize_phone'      // +43→0043→0
  | 'normalize_vat';       // Remove country prefix, format
