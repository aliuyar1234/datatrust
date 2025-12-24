export type RetryConfig = {
  /** Total attempts including the first (default: 1, i.e. no retries). */
  attempts?: number;
  /** Exponential backoff base delay (default: 200ms). */
  baseDelayMs?: number;
  /** Max backoff delay (default: 5000ms). */
  maxDelayMs?: number;
  /** Random jitter factor between 0 and 1 (default: 0.2). */
  jitter?: number;
};

export type RetryContext = {
  attempt: number;
  attempts: number;
  delayMs?: number;
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeBackoffDelayMs(cfg: Required<RetryConfig>, attempt: number): number {
  if (attempt <= 1) return 0;
  const exponent = attempt - 2;
  const raw = cfg.baseDelayMs * 2 ** exponent;
  const capped = Math.min(cfg.maxDelayMs, raw);
  const jitterFactor = 1 + (Math.random() * 2 - 1) * cfg.jitter; // +/- jitter
  return Math.max(0, Math.round(capped * jitterFactor));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function withRetries<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  cfg: RetryConfig | undefined,
  isRetryable: (err: unknown) => boolean
): Promise<T> {
  const attempts = Math.max(1, cfg?.attempts ?? 1);
  const config: Required<RetryConfig> = {
    attempts,
    baseDelayMs: cfg?.baseDelayMs ?? 200,
    maxDelayMs: cfg?.maxDelayMs ?? 5000,
    jitter: clampNumber(cfg?.jitter ?? 0.2, 0, 1),
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const delayMs = computeBackoffDelayMs(config, attempt);
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      return await fn({ attempt, attempts, delayMs: delayMs > 0 ? delayMs : undefined });
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isRetryable(err)) {
        throw err;
      }
    }
  }

  // Should be unreachable.
  throw lastError;
}

