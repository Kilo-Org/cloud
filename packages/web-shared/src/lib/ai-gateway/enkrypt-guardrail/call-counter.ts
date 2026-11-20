import { redisClient } from '@kilocode/web-shared/lib/redis';
import { enkryptCallsMinuteRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const MINUTE_MS = 60_000;

export const ENKRYPT_CALL_COUNT_TTL_SECONDS = 24 * 60 * 60;
export const ENKRYPT_CALL_COUNT_WINDOW_MINUTES = ENKRYPT_CALL_COUNT_TTL_SECONDS / 60;

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

/** Adds the calls to their minute buckets in one round trip. Never rejects: a failed write only loses the counts. */
export async function recordEnkryptCalls(
  callsByMinute: ReadonlyMap<number, number>,
  store: EnkryptCallCountStore = redisClient
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
    warnExceptInTest('[enkrypt-guardrail] call count write failed; counts dropped', {
      calls: [...callsByMinute.values()].reduce((sum, calls) => sum + calls, 0),
      error: error instanceof Error ? error.message : String(error),
    });
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
  store: EnkryptCallCountStore = redisClient
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
