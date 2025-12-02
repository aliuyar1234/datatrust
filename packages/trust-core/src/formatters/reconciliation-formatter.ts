/**
 * Reconciliation Report Formatter
 *
 * Formats reconciliation reports for LLM/MCP consumption.
 */

import type { ReconciliationReport } from '../types/index.js';

/**
 * Format a reconciliation report as plain text
 */
export function formatReconciliationReport(report: ReconciliationReport): string {
  const lines: string[] = [];
  const { summary } = report;

  // Header
  lines.push(`## Reconciliation Report`);
  lines.push(`Source: ${report.source.name} (${report.source.type})`);
  lines.push(`Target: ${report.target.name} (${report.target.type})`);
  lines.push(`Generated: ${report.timestamp.toISOString()}`);
  lines.push('');

  // Rules used
  lines.push(`### Matching Rules`);
  for (const rule of report.rules) {
    const reqStr = rule.required ? ' [required]' : '';
    lines.push(`- ${rule.name}: ${rule.sourceField} ${rule.operator} ${rule.targetField} (weight: ${rule.weight})${reqStr}`);
  }
  lines.push('');

  // Summary
  lines.push(`### Summary`);
  lines.push(`- Source Records: ${summary.sourceCount}`);
  lines.push(`- Target Records: ${summary.targetCount}`);
  lines.push(`- Matched: ${summary.matchedCount}`);
  lines.push(`- Unmatched Source: ${summary.unmatchedSourceCount}`);
  lines.push(`- Unmatched Target: ${summary.unmatchedTargetCount}`);
  lines.push(`- Average Confidence: ${summary.averageConfidence.toFixed(1)}%`);

  // Match rate
  const matchRate = summary.sourceCount > 0
    ? (summary.matchedCount / summary.sourceCount) * 100
    : 0;
  lines.push(`- Match Rate: ${matchRate.toFixed(1)}%`);
  lines.push('');

  // Matched records (sample)
  if (report.matched.length > 0) {
    lines.push(`### Matched Records (showing first 10 of ${report.matched.length})`);
    for (const match of report.matched.slice(0, 10)) {
      lines.push('');
      lines.push(`**${match.sourceKey} ↔ ${match.targetKey}** (${match.confidence.toFixed(1)}% confidence)`);
      lines.push(`- Matched rules: ${match.matchedRules.join(', ') || 'none'}`);
      if (match.failedRules.length > 0) {
        lines.push(`- Failed rules: ${match.failedRules.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Unmatched source
  if (report.unmatchedSource.length > 0) {
    lines.push(`### Unmatched Source Records (${report.unmatchedSource.length})`);
    for (const item of report.unmatchedSource.slice(0, 10)) {
      lines.push(`- ${item.key}`);
    }
    if (report.unmatchedSource.length > 10) {
      lines.push(`... and ${report.unmatchedSource.length - 10} more`);
    }
    lines.push('');
  }

  // Unmatched target
  if (report.unmatchedTarget.length > 0) {
    lines.push(`### Unmatched Target Records (${report.unmatchedTarget.length})`);
    for (const item of report.unmatchedTarget.slice(0, 10)) {
      lines.push(`- ${item.key}`);
    }
    if (report.unmatchedTarget.length > 10) {
      lines.push(`... and ${report.unmatchedTarget.length - 10} more`);
    }
    lines.push('');
  }

  // Processing time
  lines.push(`---`);
  lines.push(`Processing time: ${report.processingTimeMs}ms`);

  return lines.join('\n');
}
