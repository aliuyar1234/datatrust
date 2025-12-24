export class Semaphore {
  private inFlightCount = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(private readonly maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`Semaphore maxConcurrency must be >= 1 (got ${maxConcurrency})`);
    }
  }

  get inFlight(): number {
    return this.inFlightCount;
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.inFlightCount < this.maxConcurrency) {
      this.inFlightCount++;
      return this.createRelease();
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      this.inFlightCount--;
      const next = this.waiters.shift();
      if (next) {
        this.inFlightCount++;
        next(this.createRelease());
      }
    };
  }
}

