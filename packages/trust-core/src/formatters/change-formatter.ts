/**
 * Change Report Formatter
 *
 * Formats change detection reports for LLM/MCP consumption.
 */

import type { ChangeReport } from '../types/index.js';
import { formatKey } from './utils.js';

/**
 * Format a change report as plain text
 */
export function formatChangeReport(report: ChangeReport): string {
  const lines: string[] = [];
  const { summary } = report;

  // Header
  lines.push(`## Change Detection Report`);
  lines.push(`Connector: ${report.connector.name} (${report.connector.type})`);
  lines.push(`Since: ${report.since.toISOString()}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Generated: ${report.timestamp.toISOString()}`);
  lines.push('');

  // Summary
  lines.push(`### Summary`);
  if (summary.totalChanges === 0) {
    lines.push(`No changes detected.`);
  } else {
    lines.push(`- Total Changes: ${summary.totalChanges}`);
    if (summary.addedCount > 0) lines.push(`- Added: ${summary.addedCount}`);
    if (summary.modifiedCount > 0) lines.push(`- Modified: ${summary.modifiedCount}`);
    if (summary.deletedCount > 0) lines.push(`- Deleted: ${summary.deletedCount}`);
  }
  lines.push('');

  // Added records
  const added = report.changes.filter((c) => c.type === 'added');
  if (added.length > 0) {
    lines.push(`### Added Records (${added.length})`);
    for (const change of added.slice(0, 10)) {
      const keyStr = formatKey(change.key);
      lines.push(`- ${keyStr}`);
    }
    if (added.length > 10) {
      lines.push(`... and ${added.length - 10} more`);
    }
    lines.push('');
  }

  // Modified records
  const modified = report.changes.filter((c) => c.type === 'modified');
  if (modified.length > 0) {
    lines.push(`### Modified Records (${modified.length})`);
    for (const change of modified.slice(0, 10)) {
      const keyStr = formatKey(change.key);
      if (change.changedFields && change.changedFields.length > 0) {
        lines.push(`- ${keyStr}: fields changed: ${change.changedFields.join(', ')}`);
      } else {
        lines.push(`- ${keyStr}`);
      }
    }
    if (modified.length > 10) {
      lines.push(`... and ${modified.length - 10} more`);
    }
    lines.push('');
  }

  // Deleted records
  const deleted = report.changes.filter((c) => c.type === 'deleted');
  if (deleted.length > 0) {
    lines.push(`### Deleted Records (${deleted.length})`);
    for (const change of deleted.slice(0, 10)) {
      const keyStr = formatKey(change.key);
      lines.push(`- ${keyStr}`);
    }
    if (deleted.length > 10) {
      lines.push(`... and ${deleted.length - 10} more`);
    }
    lines.push('');
  }

  // Processing time
  lines.push(`---`);
  lines.push(`Processing time: ${report.processingTimeMs}ms`);

  return lines.join('\n');
}
