/**
 * Reconciliation Engine Interface
 *
 * Interface for matching and reconciling records between connectors.
 */

import type { IConnector } from '@datatrust/core';
import type {
  ReconciliationReport,
  ReconciliationOptions,
} from '../types/index.js';

/**
 * Reconciliation Engine Interface
 *
 * Provides methods for matching records between two data sources
 * using configurable rules and confidence scoring.
 */
export interface IReconciliationEngine {
  /**
   * Reconcile records between source and target connectors.
   *
   * @param source - Source connector
   * @param target - Target connector
   * @param options - Matching rules and options
   * @returns Reconciliation report with matches and unmatched records
   */
  reconcile(
    source: IConnector,
    target: IConnector,
    options: ReconciliationOptions
  ): Promise<ReconciliationReport>;
}
