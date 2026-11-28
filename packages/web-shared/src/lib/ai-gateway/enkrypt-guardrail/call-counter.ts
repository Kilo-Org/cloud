import { deferredRedisClient, redisClient } from '@kilocode/web-shared/lib/redis';
import { enkryptCallsMinuteRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const MINUTE_MS = 60_000;

export const ENKRYPT_CALL_COUNT_WINDOW_MINUTES = 24 * 60;
/**
 * A bucket's TTL restarts with each write, which can come at the end of its minute, so it is kept a
 * few minutes beyond the window for its oldest bucket to still be there when read.
 */
export const ENKRYPT_CALL_COUNT_TTL_SECONDS = (ENKRYPT_CALL_COUNT_WINDOW_MINUTES + 5) * 60;

export type EnkryptCallCountStore = {
  pipeline(): {
    incrby(key: string, increment: number): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<unknown>;
  };
  mget(keys: string[]): Promise<unknown[]>;
};

/** Minutes since the Unix epoch. */
export function enkryptCallMinute(at: number): number {
  return Math.floor(at / MINUTE_MS);
}

/**
 * Adds the calls to their minute buckets in one round trip. Never rejects: a failed write only
 * loses the counts. A timed-out write may still have been applied, since the abort does not stop
 * a request Redis already received; it is not retried, so the counts are never added twice.
 */
export async function recordEnkryptCalls(
  callsByMinute: ReadonlyMap<number, number>,
  store: EnkryptCallCountStore = deferredRedisClient
): Promise<void> {
  if (callsByMinute.size === 0) return;
  try {
    const pipeline = store.pipeline();
    for (const [minute, calls] of callsByMinute) {
      const key = enkryptCallsMinuteRedisKey(minute);
      pipeline.incrby(key, calls);
      pipeline.expire(key, ENKRYPT_CALL_COUNT_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    warnExceptInTest(
      timedOut
        ? '[enkrypt-guardrail] call count write timed out; counts may be lost'
        : '[enkrypt-guardrail] call count write failed; counts lost',
      {
        calls: [...callsByMinute.values()].reduce((sum, calls) => sum + calls, 0),
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

export type EnkryptCallCounter = {
  /** `fetch` that counts each request it starts in the minute it starts in. */
  fetch: typeof fetch;
  /**
   * Writes the calls counted since the last flush; pass it to `after()` once the guardrail made
   * its last call. A gateway request in `sfo1` writes to the Redis primary in `fra1`, so the
   * counts of a request are written together, after its calls rather than before each one.
   */
  flush: () => Promise<void>;
};

export function countEnkryptCalls(
  baseFetch: typeof fetch = fetch,
  store: EnkryptCallCountStore = deferredRedisClient
): EnkryptCallCounter {
  let pending = new Map<number, number>();
  return {
    fetch: (input, init) => {
      const minute = enkryptCallMinute(Date.now());
      pending.set(minute, (pending.get(minute) ?? 0) + 1);
      return baseFetch(input, init);
    },
    flush: async () => {
      const calls = pending;
      pending = new Map();
      await recordEnkryptCalls(calls, store);
    },
  };
}

/** How old the shared count a rate limit decision is based on may get. */
export const ENKRYPT_CALL_RATE_REFRESH_MS = 5_000;

export type EnkryptCallRateStore = {
  get(key: string): Promise<unknown>;
};

export type EnkryptCallRateLimiter = {
  /**
   * Whether one more Enkrypt call may start now under `callsPerMinute`, counting it when it may.
   * Never waits for Redis.
   */
  tryAcquire(callsPerMinute: number): boolean;
};

/**
 * A coarse limit on the Enkrypt calls of all gateway instances together, per minute bucket.
 *
 * The estimate of the current minute's calls is the shared count of that minute, which the call
 * counter writes, plus the calls this instance admitted since the count was read. The shared count
 * is read from the closest Redis replica, in the background at most every
 * `ENKRYPT_CALL_RATE_REFRESH_MS`, so a decision never waits for Redis and never crosses the
 * Atlantic. The estimate trails: other instances' calls appear once their requests flushed their
 * counts and the read after that refreshed it, and a new minute starts from this instance's calls
 * alone. A failed read keeps the last count, so a Redis outage never stops calls.
 */
export function createEnkryptCallRateLimiter(
  store: EnkryptCallRateStore = redisClient,
  now: () => number = Date.now
): EnkryptCallRateLimiter {
  let minute = enkryptCallMinute(now());
  /** Calls this instance admitted in `minute`. */
  let admitted = 0;
  let shared: { minute: number; count: number; admittedAtRead: number } | null = null;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let reading = false;
  let warnedMinute: number | null = null;

  const refresh = (at: number) => {
    if (reading || at - lastReadAt < ENKRYPT_CALL_RATE_REFRESH_MS) return;
    reading = true;
    lastReadAt = at;
    const readMinute = minute;
    const admittedAtRead = admitted;
    void Promise.resolve()
      .then(() => store.get(enkryptCallsMinuteRedisKey(readMinute)))
      .then(value => {
        if (readMinute === minute) {
          shared = {
            minute: readMinute,
            count: parseCount(value),
            admittedAtRead,
          };
        }
      })
      .catch((error: unknown) => {
        warnExceptInTest('[enkrypt-guardrail] call rate count read failed; using the last count', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        reading = false;
      });
  };

  return {
    tryAcquire(callsPerMinute) {
      const at = now();
      const current = enkryptCallMinute(at);
      if (current !== minute) {
        minute = current;
        admitted = 0;
        lastReadAt = Number.NEGATIVE_INFINITY;
      }
      refresh(at);
      const counted =
        shared?.minute === minute ? shared.count + admitted - shared.admittedAtRead : admitted;
      if (counted >= callsPerMinute) {
        if (warnedMinute !== minute) {
          warnedMinute = minute;
          warnExceptInTest('[enkrypt-guardrail] call rate limit reached; calls fail open', {
            calls_per_minute: callsPerMinute,
            counted_calls: counted,
          });
        }
        return false;
      }
      admitted += 1;
      return true;
    },
  };
}

/** The rate limiter shared by the guardrails of this instance. */
export const enkryptCallRateLimiter = createEnkryptCallRateLimiter();

export type EnkryptCallCounts = {
  /** Start of each minute bucket, oldest first, as epoch milliseconds. */
  bucketStarts: number[];
  calls: number[];
};

function parseCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Calls per minute over the `minutes` complete buckets before the current one, which is still
 * filling up.
 */
export async function getEnkryptCallCounts(
  now = Date.now(),
  minutes = ENKRYPT_CALL_COUNT_WINDOW_MINUTES,
  store: EnkryptCallCountStore = redisClient
): Promise<EnkryptCallCounts> {
  const current = enkryptCallMinute(now);
  const bucketMinutes = Array.from({ length: minutes }, (_, index) => current - minutes + index);
  const values = await store.mget(bucketMinutes.map(enkryptCallsMinuteRedisKey));
  return {
    bucketStarts: bucketMinutes.map(minute => minute * MINUTE_MS),
    calls: bucketMinutes.map((_, index) => parseCount(values[index])),
  };
}
