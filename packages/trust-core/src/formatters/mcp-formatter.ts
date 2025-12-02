/**
 * MCP Formatter
 *
 * Unified formatter class for all trust-core reports.
 * Delegates to specialized formatters for each report type.
 */

import type {
  ConsistencyReport,
  ChangeReport,
  AuditReport,
  ReconciliationReport,
} from '../types/index.js';

import {
  formatConsistencyReport,
  formatAsText,
  type MCPSummary,
  type MCPFormattedReport,
} from './consistency-formatter.js';
import { formatChangeReport } from './change-formatter.js';
import { formatAuditReport } from './audit-formatter.js';
import { formatReconciliationReport } from './reconciliation-formatter.js';

// Re-export types
export type { MCPSummary, MCPFormattedReport };

/**
 * Unified formatter for all trust-core reports.
 *
 * Provides a consistent interface for formatting reports
 * for LLM/MCP consumption.
 */
export class MCPFormatter {
  /**
   * Format a consistency report for MCP/LLM consumption
   */
  format(report: ConsistencyReport): MCPFormattedReport {
    return formatConsistencyReport(report);
  }

  /**
   * Format a consistency report as plain text
   */
  formatAsText(report: ConsistencyReport): string {
    return formatAsText(report);
  }

  /**
   * Format a change report as plain text
   */
  formatChangeReport(report: ChangeReport): string {
    return formatChangeReport(report);
  }

  /**
   * Format an audit report as plain text
   */
  formatAuditReport(report: AuditReport): string {
    return formatAuditReport(report);
  }

  /**
   * Format a reconciliation report as plain text
   */
  formatReconciliationReport(report: ReconciliationReport): string {
    return formatReconciliationReport(report);
  }
}
