/**
 * @datatrust/entity-resolution
 *
 * Entity resolution helpers (similarity + types).
 *
 * Note: Full resolution pipelines (blocking/LLM) are not yet implemented in this package,
 * but the similarity algorithms are production-usable and are integrated into trust-core.
 */

export * from './similarity/index.js';
export * from './blocking/index.js';
export * from './types/index.js';
