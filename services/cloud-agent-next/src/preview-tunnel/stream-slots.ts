export type StreamSlotLimits = {
  capacity: number;
  maxWaiters: number;
  waitMs: number;
};

/**
 * Admission for one kind of tunnel stream. A request over the capacity waits,
 * in arrival order, for a free slot for a bounded time. The number of waiting
 * requests has a bound too; a request over it fails at once.
 */
export class StreamSlots {
  private used = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limits: () => StreamSlotLimits) {}

  get inUse(): number {
    return this.used;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Counts the streams that held a slot before a wake, for example live browser sockets. */
  restore(count: number): void {
    this.used = count;
  }

  /** True when the caller holds a slot; false when the wait is full or ends. */
  acquire(): Promise<boolean> {
    const limits = this.limits();
    if (this.used < limits.capacity) {
      this.used += 1;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= limits.maxWaiters) return Promise.resolve(false);
    return new Promise(resolve => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      }, limits.waitMs);
      this.waiters.push(grant);
    });
  }

  /** Frees one slot. The first waiting request takes it at once. */
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.used = Math.max(0, this.used - 1);
  }
}
