import { fail, ok, type Result } from './protocol';

const PERIOD_MS = 60_000;
const BLOCK_REQUESTS = 10;
const SESSION_REQUESTS = 1200;

/** Instance-local session bucket and prepaid user credits; eviction only loses credits. */
export class DataRateLimit {
  private tokens = SESSION_REQUESTS;
  private updatedAt = Date.now();
  private windowEnd = 0;
  private credits = new Map<string, number>();
  private gate: Promise<void> = Promise.resolve();

  async admit(limiter: RateLimit, userID: string): Promise<Result<null>> {
    const prior = this.gate;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.gate = promise;
    await prior;
    try {
      let now = Date.now();
      this.tokens = Math.min(
        SESSION_REQUESTS,
        this.tokens + ((now - this.updatedAt) * SESSION_REQUESTS) / PERIOD_MS
      );
      this.updatedAt = now;
      if (this.tokens < 1) return this.denied(now);
      for (;;) {
        if (now >= this.windowEnd) {
          this.credits.clear();
          this.windowEnd = (Math.floor(now / PERIOD_MS) + 1) * PERIOD_MS;
        }
        const remaining = this.credits.get(userID) ?? 0;
        if (remaining > 0) {
          this.credits.set(userID, remaining - 1);
          this.tokens--;
          return ok(null);
        }
        const chargedWindowEnd = this.windowEnd;
        if (!(await limiter.limit({ key: userID })).success) return this.denied(Date.now());
        now = Date.now();
        // Never carry credits purchased in the preceding window across its boundary.
        if (now >= chargedWindowEnd) continue;
        this.credits.set(userID, BLOCK_REQUESTS);
      }
    } finally {
      resolve();
    }
  }

  private denied(now: number): Result<never> {
    return fail('rate_limited', 'Too many requests; retry later', { retryAt: now + PERIOD_MS });
  }
}
