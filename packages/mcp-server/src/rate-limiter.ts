export type RateLimitKeyMode = 'ip' | 'subject' | 'ip+subject';

export type RateLimitConfig = {
  enabled?: boolean;
  windowMs?: number;
  maxRequests?: number;
  key?: RateLimitKeyMode;
};

type Bucket = {
  resetAt: number;
  count: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly cfg: Required<Pick<RateLimitConfig, 'windowMs' | 'maxRequests' | 'key'>>) {}

  static fromConfig(cfg?: RateLimitConfig): RateLimiter | null {
    if (cfg?.enabled === false) return null;
    const enabled = cfg?.enabled ?? false;
    if (!enabled) return null;
    return new RateLimiter({
      windowMs: cfg?.windowMs ?? 60_000,
      maxRequests: cfg?.maxRequests ?? 120,
      key: cfg?.key ?? 'ip',
    });
  }

  check(key: string, now = Date.now()): RateLimitResult {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      const next: Bucket = { resetAt: now + this.cfg.windowMs, count: 1 };
      this.buckets.set(key, next);
      return {
        allowed: true,
        limit: this.cfg.maxRequests,
        remaining: Math.max(0, this.cfg.maxRequests - 1),
        resetAt: next.resetAt,
      };
    }

    bucket.count++;
    const remaining = Math.max(0, this.cfg.maxRequests - bucket.count);
    return {
      allowed: bucket.count <= this.cfg.maxRequests,
      limit: this.cfg.maxRequests,
      remaining,
      resetAt: bucket.resetAt,
    };
  }

  prune(now = Date.now()): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }
}

