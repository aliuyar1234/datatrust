/**
 * Audit Report Formatter
 *
 * Formats audit reports for LLM/MCP consumption.
 */

import type { AuditReport } from '../types/index.js';
import { formatKey } from './utils.js';

/**
 * Format an audit report as plain text
 */
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  const { summary } = report;

  // Header
  lines.push(`## Audit Log Report`);
  lines.push(`Generated: ${report.timestamp.toISOString()}`);
  lines.push('');

  // Query info
  lines.push(`### Query`);
  if (report.query.connectorId) {
    lines.push(`- Connector: ${report.query.connectorId}`);
  }
  if (report.query.operation) {
    const ops = Array.isArray(report.query.operation)
      ? report.query.operation.join(', ')
      : report.query.operation;
    lines.push(`- Operation: ${ops}`);
  }
  if (report.query.recordKey) {
    lines.push(`- Record Key: ${report.query.recordKey}`);
  }
  if (report.query.user) {
    lines.push(`- User: ${report.query.user}`);
  }
  if (report.query.from) {
    lines.push(`- From: ${report.query.from.toISOString()}`);
  }
  if (report.query.to) {
    lines.push(`- To: ${report.query.to.toISOString()}`);
  }
  lines.push('');

  // Summary
  lines.push(`### Summary`);
  lines.push(`- Total Entries: ${summary.totalCount}`);
  if (summary.createCount > 0) lines.push(`- Creates: ${summary.createCount}`);
  if (summary.updateCount > 0) lines.push(`- Updates: ${summary.updateCount}`);
  if (summary.deleteCount > 0) lines.push(`- Deletes: ${summary.deleteCount}`);
  lines.push('');

  // Entries
  if (report.entries.length > 0) {
    lines.push(`### Entries (showing ${report.entries.length} of ${report.totalCount})`);
    for (const entry of report.entries.slice(0, 20)) {
      lines.push('');
      lines.push(`**${entry.operation.toUpperCase()}** - ${entry.timestamp.toISOString()}`);
      lines.push(`- Connector: ${entry.connectorId}`);
      lines.push(`- Record: ${formatKey(entry.recordKey)}`);
      if (entry.user) lines.push(`- User: ${entry.user}`);
      if (entry.changedFields && entry.changedFields.length > 0) {
        lines.push(`- Changed: ${entry.changedFields.join(', ')}`);
      }
    }
    if (report.entries.length > 20) {
      lines.push('');
      lines.push(`... and ${report.entries.length - 20} more entries`);
    }
  } else {
    lines.push(`### Entries`);
    lines.push(`No matching entries found.`);
  }

  return lines.join('\n');
}
