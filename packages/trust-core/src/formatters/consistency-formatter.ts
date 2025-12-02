/**
 * Consistency Report Formatter
 *
 * Formats consistency reports for LLM/MCP consumption.
 */

import type {
  ConsistencyReport,
  ComparisonSummary,
} from '../types/index.js';

export interface MCPSummary {
  status: 'consistent' | 'inconsistent' | 'partial';
  message: string;
  stats: {
    total: number;
    matching: number;
    different: number;
    sourceOnly: number;
    targetOnly: number;
  };
  topDifferingFields: Array<{ field: string; count: number }>;
}

export interface MCPFormattedReport {
  summary: MCPSummary;
  insights: string[];
  text: string;
}

/**
 * Format a consistency report for MCP/LLM consumption
 */
export function formatConsistencyReport(report: ConsistencyReport): MCPFormattedReport {
  const summary = formatSummary(report);
  const insights = generateInsights(report);
  const text = formatAsText(report);

  return { summary, insights, text };
}

/**
 * Format as plain text suitable for tool output
 */
export function formatAsText(report: ConsistencyReport): string {
  const lines: string[] = [];
  const { summary } = report;

  // Header
  lines.push(`## Consistency Check Report`);
  lines.push(`Source: ${report.source.name} (${report.source.type})`);
  lines.push(`Target: ${report.target.name} (${report.target.type})`);
  lines.push(`Generated: ${report.timestamp.toISOString()}`);
  lines.push('');

  // Summary
  lines.push(`### Summary`);
  lines.push(`- Total Source Records: ${summary.sourceRecordCount}`);
  lines.push(`- Total Target Records: ${summary.targetRecordCount}`);
  lines.push(`- Matching: ${summary.matchCount}`);
  lines.push(`- With Differences: ${summary.differenceCount}`);
  lines.push(`- Only in Source: ${summary.sourceOnlyCount}`);
  lines.push(`- Only in Target: ${summary.targetOnlyCount}`);

  // Consistency rate
  const consistencyRate =
    summary.sourceRecordCount > 0
      ? (summary.matchCount / summary.sourceRecordCount) * 100
      : 100;
  lines.push(`- Consistency Rate: ${consistencyRate.toFixed(1)}%`);
  lines.push('');

  // Top differing fields
  if (summary.differencesByField.size > 0) {
    lines.push(`### Fields with Most Differences`);
    const sortedFields = Array.from(summary.differencesByField.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [field, count] of sortedFields) {
      lines.push(`- ${field}: ${count} differences`);
    }
    lines.push('');
  }

  // Sample differences
  const differences = report.records.filter((r) => r.status === 'difference');
  if (differences.length > 0) {
    lines.push(`### Sample Differences (first 10)`);
    for (const diff of differences.slice(0, 10)) {
      const keyStr =
        typeof diff.key === 'string' ? diff.key : JSON.stringify(diff.key);
      lines.push(`\n**Record Key: ${keyStr}**`);
      for (const fd of diff.differences ?? []) {
        lines.push(`  - ${fd.field}: "${fd.sourceValue}" → "${fd.targetValue}"`);
      }
    }
    lines.push('');
  }

  // Source-only records
  const sourceOnly = report.records.filter((r) => r.status === 'source_only');
  if (sourceOnly.length > 0) {
    lines.push(`### Records Only in Source (first 10)`);
    for (const record of sourceOnly.slice(0, 10)) {
      const keyStr =
        typeof record.key === 'string'
          ? record.key
          : JSON.stringify(record.key);
      lines.push(`- ${keyStr}`);
    }
    if (sourceOnly.length > 10) {
      lines.push(`... and ${sourceOnly.length - 10} more`);
    }
    lines.push('');
  }

  // Target-only records
  const targetOnly = report.records.filter((r) => r.status === 'target_only');
  if (targetOnly.length > 0) {
    lines.push(`### Records Only in Target (first 10)`);
    for (const record of targetOnly.slice(0, 10)) {
      const keyStr =
        typeof record.key === 'string'
          ? record.key
          : JSON.stringify(record.key);
      lines.push(`- ${keyStr}`);
    }
    if (targetOnly.length > 10) {
      lines.push(`... and ${targetOnly.length - 10} more`);
    }
    lines.push('');
  }

  // Processing time
  lines.push(`---`);
  lines.push(`Processing time: ${summary.processingTimeMs}ms`);

  return lines.join('\n');
}

function formatSummary(report: ConsistencyReport): MCPSummary {
  const { summary } = report;
  const isConsistent =
    summary.differenceCount === 0 &&
    summary.sourceOnlyCount === 0 &&
    summary.targetOnlyCount === 0;

  const status: MCPSummary['status'] = isConsistent
    ? 'consistent'
    : summary.matchCount > 0
      ? 'partial'
      : 'inconsistent';

  const message = isConsistent
    ? `All ${summary.matchCount} records are consistent between source and target.`
    : `Found ${summary.differenceCount} records with differences, ` +
      `${summary.sourceOnlyCount} only in source, ${summary.targetOnlyCount} only in target.`;

  const topDifferingFields = Array.from(summary.differencesByField.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([field, count]) => ({ field, count }));

  return {
    status,
    message,
    stats: {
      total: summary.sourceRecordCount,
      matching: summary.matchCount,
      different: summary.differenceCount,
      sourceOnly: summary.sourceOnlyCount,
      targetOnly: summary.targetOnlyCount,
    },
    topDifferingFields,
  };
}

function generateInsights(report: ConsistencyReport): string[] {
  const insights: string[] = [];
  const { summary } = report;

  // Consistency rate
  const consistencyRate =
    summary.sourceRecordCount > 0
      ? (summary.matchCount / summary.sourceRecordCount) * 100
      : 100;
  insights.push(`Consistency rate: ${consistencyRate.toFixed(1)}%`);

  // Most problematic field
  if (summary.differencesByField.size > 0) {
    const [topField, topCount] = Array.from(summary.differencesByField.entries()).sort(
      (a, b) => b[1] - a[1]
    )[0]!;
    insights.push(
      `Most inconsistent field: "${topField}" with ${topCount} differences`
    );
  }

  // Missing records
  if (summary.sourceOnlyCount > 0) {
    insights.push(
      `${summary.sourceOnlyCount} records exist in source but not in target - may need sync`
    );
  }
  if (summary.targetOnlyCount > 0) {
    insights.push(
      `${summary.targetOnlyCount} records exist in target but not in source - may be orphaned`
    );
  }

  return insights;
}
