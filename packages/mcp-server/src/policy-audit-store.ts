import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type PolicyAuditRemoteSink = {
  url: string;
  bearerTokenEnv?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

export type PolicyAuditEntry = {
  /** Stable policy decision ID (also returned to clients). */
  decision_id: string;
  timestamp: Date;
  trace_id?: string;
  policy_version?: string;
  tool: string;
  connectors: string[];
  decision: 'allow' | 'deny';
  reason: string;
  rule_id?: string;
  subject?: string;
  tenant?: string;
  break_glass?: boolean;
  request?: Record<string, unknown>;
};

export type PolicyAuditStoreOptions = {
  baseDir?: string;
  retentionDays?: number;
  maxFileBytes?: number;
  remote?: PolicyAuditRemoteSink;
};

type AuditStatus = {
  lastWriteAt?: string;
  lastError?: string;
};

type HashState = {
  filePath: string;
  lastHash: string;
};

export class PolicyAuditStore {
  private static writeQueue = new Map<string, Promise<void>>();
  private readonly options: Required<Pick<PolicyAuditStoreOptions, 'baseDir'>> &
    PolicyAuditStoreOptions;
  private readonly status: AuditStatus = {};
  private readonly lastHashByFile = new Map<string, string>();

  constructor(options?: PolicyAuditStoreOptions) {
    this.options = {
      baseDir: options?.baseDir ?? './.policy-audit',
      retentionDays: options?.retentionDays,
      maxFileBytes: options?.maxFileBytes ?? 10 * 1024 * 1024,
      remote: options?.remote,
    };
  }

  getStatus(): AuditStatus {
    return { ...this.status };
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.options.baseDir, { recursive: true, mode: 0o700 });
  }

  private async listFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.options.baseDir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async prune(): Promise<void> {
    const retentionDays = this.options.retentionDays;
    if (!retentionDays) return;
    const files = await this.listFiles();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith('.ndjson')) continue;
      const full = path.join(this.options.baseDir, file);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(full);
        }
      } catch {
        // Best-effort.
      }
    }
  }

  private getBaseName(date: Date): string {
    return date.toISOString().split('T')[0] ?? 'unknown-date';
  }

  private async resolveWritableFilePath(date: Date): Promise<string> {
    const baseName = this.getBaseName(date);
    const maxBytes = this.options.maxFileBytes ?? 10 * 1024 * 1024;

    // Try: YYYY-MM-DD.ndjson, then YYYY-MM-DD-1.ndjson, ...
    for (let i = 0; i < 10_000; i++) {
      const fileName = i === 0 ? `${baseName}.ndjson` : `${baseName}-${i}.ndjson`;
      const full = path.join(this.options.baseDir, fileName);
      try {
        const stat = await fs.stat(full);
        if (stat.size < maxBytes) return full;
      } catch {
        return full;
      }
    }

    return path.join(this.options.baseDir, `${baseName}-${Date.now()}.ndjson`);
  }

  private async readLastHash(filePath: string): Promise<string> {
    const cached = this.lastHashByFile.get(filePath);
    if (cached) return cached;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      const last = lines.at(-1);
      if (!last) return '0';
      const parsed = JSON.parse(last) as { hash?: unknown };
      const hash = typeof parsed.hash === 'string' ? parsed.hash : '0';
      this.lastHashByFile.set(filePath, hash);
      return hash;
    } catch {
      return '0';
    }
  }

  private computeHash(prevHash: string, record: unknown): string {
    const payload = `${prevHash}\n${JSON.stringify(record)}`;
    return createHash('sha256').update(payload).digest('hex');
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

  private async emitRemote(record: unknown): Promise<void> {
    const remote = this.options.remote;
    if (!remote) return;

    const controller = new AbortController();
    const timeoutMs = remote.timeoutMs ?? 10_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(remote.headers ?? {}),
      };
      if (remote.bearerTokenEnv) {
        const token = process.env[remote.bearerTokenEnv];
        if (token) headers['Authorization'] = `Bearer ${token}`;
      }

      await fetch(remote.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(record),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async append(entry: PolicyAuditEntry): Promise<void> {
    await this.ensureDir();
    await this.prune();

    const filePath = await this.resolveWritableFilePath(entry.timestamp);
    const prevHash = await this.readLastHash(filePath);

    const record = {
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    };
    const hash = this.computeHash(prevHash, record);
    const line = `${JSON.stringify({ ...record, prev_hash: prevHash, hash })}\n`;

    await this.enqueueWrite(filePath, async () => {
      try {
        await fs.appendFile(filePath, line, { encoding: 'utf-8', mode: 0o600 });
        this.lastHashByFile.set(filePath, hash);
        this.status.lastWriteAt = new Date().toISOString();
        this.status.lastError = undefined;
      } catch (err) {
        this.status.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      }

      try {
        await this.emitRemote({ ...record, prev_hash: prevHash, hash });
      } catch (err) {
        this.status.lastError = err instanceof Error ? err.message : String(err);
      }
    });
  }
}

