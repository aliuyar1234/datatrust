import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

type LogRecord = {
  ts: string;
  level: LogLevel;
  msg: string;
  traceId?: string;
  [key: string]: unknown;
};

const SECRET_KEY_PATTERN =
  /^(password|pass|token|accessToken|apiKey|secret|connectionString|uri|authorization)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function redactString(value: string): string {
  // Bearer tokens
  let out = value.replace(/\bBearer\s+([A-Za-z0-9._-]{8,})\b/g, 'Bearer [REDACTED]');

  // Common URL credentials patterns: scheme://user:pass@host
  out = out.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)([^@\s/]+)(@)/gi,
    `$1[REDACTED]$3`
  );

  return out;
}

export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redactSecrets(v);
    }
    return out;
  }
  return String(value);
}

export class Logger {
  constructor(
    private readonly options: {
      level?: LogLevel;
      format?: LogFormat;
    } = {}
  ) {}

  private shouldLog(level: LogLevel): boolean {
    const configured = this.options.level ?? 'info';
    const order: Record<LogLevel, number> = {
      debug: 10,
      info: 20,
      warn: 30,
      error: 40,
    };
    return order[level] >= order[configured];
  }

  child(fields: Record<string, unknown>): Logger {
    const parent = this;
    return new (class extends Logger {
      override log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
        parent.log(level, msg, { ...fields, ...(extra ?? {}) });
      }
    })(this.options);
  }

  log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(extra ?? {}),
    };

    const sanitized = redactSecrets(record) as LogRecord;

    if ((this.options.format ?? 'text') === 'json') {
      // Never log to stdout; MCP protocol uses stdout.
      process.stderr.write(`${JSON.stringify(sanitized)}\n`);
      return;
    }

    const tracePart = sanitized.traceId ? ` trace=${sanitized.traceId}` : '';
    process.stderr.write(`[${sanitized.ts}] ${sanitized.level.toUpperCase()}${tracePart} ${sanitized.msg}\n`);
  }

  debug(msg: string, extra?: Record<string, unknown>) {
    this.log('debug', msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>) {
    this.log('info', msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>) {
    this.log('warn', msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>) {
    this.log('error', msg, extra);
  }
}

export function createTraceId(): string {
  return randomUUID();
}

