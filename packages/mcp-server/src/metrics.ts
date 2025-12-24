export type ToolOutcome = 'success' | 'error' | 'denied';
export type ConnectorOutcome = 'success' | 'error';

type CounterKey = string;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelsToKey(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

export class Metrics {
  private readonly startedAt = Date.now();
  private readonly counters = new Map<CounterKey, number>();
  private readonly durationMsSumByTool = new Map<string, number>();
  private readonly durationMsCountByTool = new Map<string, number>();
  private readonly durationMsSumByConnectorOp = new Map<string, number>();
  private readonly durationMsCountByConnectorOp = new Map<string, number>();

  incTool(tool: string, outcome: ToolOutcome): void {
    const key = `datatrust_tool_requests_total${labelsToKey({ tool, outcome })}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observeToolDuration(tool: string, durationMs: number): void {
    this.durationMsSumByTool.set(tool, (this.durationMsSumByTool.get(tool) ?? 0) + durationMs);
    this.durationMsCountByTool.set(tool, (this.durationMsCountByTool.get(tool) ?? 0) + 1);
  }

  incConnector(connector: string, operation: string, outcome: ConnectorOutcome): void {
    const key = `datatrust_connector_requests_total${labelsToKey({
      connector,
      operation,
      outcome,
    })}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observeConnectorDuration(connector: string, operation: string, durationMs: number): void {
    const key = `${connector}|${operation}`;
    this.durationMsSumByConnectorOp.set(key, (this.durationMsSumByConnectorOp.get(key) ?? 0) + durationMs);
    this.durationMsCountByConnectorOp.set(key, (this.durationMsCountByConnectorOp.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines: string[] = [];
    const sortedCounters = Array.from(this.counters.entries()).sort(([a], [b]) => a.localeCompare(b));

    lines.push('# HELP datatrust_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE datatrust_uptime_seconds gauge');
    lines.push(`datatrust_uptime_seconds ${(Date.now() - this.startedAt) / 1000}`);

    lines.push('# HELP datatrust_tool_requests_total Total MCP tool requests');
    lines.push('# TYPE datatrust_tool_requests_total counter');
    for (const [key, value] of sortedCounters.filter(([k]) => k.startsWith('datatrust_tool_requests_total'))) {
      lines.push(`${key} ${value}`);
    }

    lines.push('# HELP datatrust_tool_duration_ms Tool execution duration in milliseconds');
    lines.push('# TYPE datatrust_tool_duration_ms summary');
    for (const tool of Array.from(this.durationMsSumByTool.keys()).sort()) {
      const sum = this.durationMsSumByTool.get(tool) ?? 0;
      const count = this.durationMsCountByTool.get(tool) ?? 0;
      lines.push(`datatrust_tool_duration_ms_sum${labelsToKey({ tool })} ${sum}`);
      lines.push(`datatrust_tool_duration_ms_count${labelsToKey({ tool })} ${count}`);
    }

    lines.push('# HELP datatrust_connector_requests_total Total connector method calls');
    lines.push('# TYPE datatrust_connector_requests_total counter');
    for (const [key, value] of sortedCounters.filter(([k]) =>
      k.startsWith('datatrust_connector_requests_total')
    )) {
      lines.push(`${key} ${value}`);
    }

    lines.push('# HELP datatrust_connector_duration_ms Connector call duration in milliseconds');
    lines.push('# TYPE datatrust_connector_duration_ms summary');
    for (const key of Array.from(this.durationMsSumByConnectorOp.keys()).sort()) {
      const [connector, operation] = key.split('|', 2);
      if (!connector || !operation) continue;
      const sum = this.durationMsSumByConnectorOp.get(key) ?? 0;
      const count = this.durationMsCountByConnectorOp.get(key) ?? 0;
      lines.push(`datatrust_connector_duration_ms_sum${labelsToKey({ connector, operation })} ${sum}`);
      lines.push(`datatrust_connector_duration_ms_count${labelsToKey({ connector, operation })} ${count}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

export const metrics = new Metrics();
