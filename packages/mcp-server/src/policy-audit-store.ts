import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type PolicyAuditEntry = {
  id: string;
  timestamp: Date;
  traceId?: string;
  decision: 'allow' | 'deny';
  tool: string;
  connectors: string[];
  reason: string;
  request?: Record<string, unknown>;
};

export class PolicyAuditStore {
  private static writeQueue = new Map<string, Promise<void>>();

  constructor(private readonly baseDir: string = './.policy-audit') {}

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private getFilePath(date: Date): string {
    const dateStr = date.toISOString().split('T')[0];
    return path.join(this.baseDir, `${dateStr}.ndjson`);
  }

  private enqueueWrite(filePath: string, op: () => Promise<void>): Promise<void> {
    const previous = PolicyAuditStore.writeQueue.get(filePath) ?? Promise.resolve();
    const next = previous.then(op, op);
    let wrapped: Promise<void>;
    wrapped = next.finally(() => {
      if (PolicyAuditStore.writeQueue.get(filePath) === wrapped) {
        PolicyAuditStore.writeQueue.delete(filePath);
      }
    });
    PolicyAuditStore.writeQueue.set(filePath, wrapped);
    return wrapped;
  }

  async append(entry: PolicyAuditEntry): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(entry.timestamp);
    const line = `${JSON.stringify({
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    })}\n`;
    await this.enqueueWrite(filePath, async () => {
      await fs.appendFile(filePath, line, { encoding: 'utf-8', mode: 0o600 });
    });
  }
}

