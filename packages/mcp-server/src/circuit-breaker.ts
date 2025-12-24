export type CircuitBreakerConfig = {
  enabled?: boolean;
  /** Open after N consecutive failures (default: 5). */
  failureThreshold?: number;
  /** How long to stay open before allowing a single probe request (default: 30000ms). */
  openMs?: number;
};

type State =
  | { mode: 'closed'; failures: number }
  | { mode: 'open'; openedAt: number }
  | { mode: 'half_open'; probeInFlight: boolean };

export class CircuitBreaker {
  private state: State = { mode: 'closed', failures: 0 };

  constructor(private readonly cfg: Required<CircuitBreakerConfig>) {}

  static fromConfig(cfg?: CircuitBreakerConfig): CircuitBreaker | null {
    if (cfg?.enabled === false) return null;
    const enabled = cfg?.enabled ?? false;
    if (!enabled) return null;
    return new CircuitBreaker({
      enabled: true,
      failureThreshold: Math.max(1, cfg?.failureThreshold ?? 5),
      openMs: Math.max(1, cfg?.openMs ?? 30_000),
    });
  }

  canRequest(now = Date.now()): boolean {
    if (this.state.mode === 'closed') return true;

    if (this.state.mode === 'open') {
      if (now - this.state.openedAt < this.cfg.openMs) return false;
      this.state = { mode: 'half_open', probeInFlight: false };
      return this.canRequest(now);
    }

    return !this.state.probeInFlight;
  }

  onStart(): void {
    if (this.state.mode === 'half_open') {
      this.state.probeInFlight = true;
    }
  }

  onSuccess(): void {
    if (this.state.mode === 'half_open') {
      this.state = { mode: 'closed', failures: 0 };
      return;
    }

    if (this.state.mode === 'closed') {
      this.state.failures = 0;
    }
  }

  onFailure(now = Date.now()): void {
    if (this.state.mode === 'half_open') {
      this.state = { mode: 'open', openedAt: now };
      return;
    }

    if (this.state.mode === 'closed') {
      this.state.failures++;
      if (this.state.failures >= this.cfg.failureThreshold) {
        this.state = { mode: 'open', openedAt: now };
      }
    }
  }

  getSnapshot(now = Date.now()): { mode: State['mode']; openForMs?: number; failures?: number } {
    if (this.state.mode === 'open') {
      return { mode: 'open', openForMs: Math.max(0, this.cfg.openMs - (now - this.state.openedAt)) };
    }
    if (this.state.mode === 'closed') {
      return { mode: 'closed', failures: this.state.failures };
    }
    return { mode: 'half_open' };
  }
}

