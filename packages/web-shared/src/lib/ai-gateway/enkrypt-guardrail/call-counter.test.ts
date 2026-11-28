import {
  countEnkryptCalls,
  createEnkryptCallRateLimiter,
  ENKRYPT_CALL_COUNT_TTL_SECONDS,
  ENKRYPT_CALL_RATE_REFRESH_MS,
  ENKRYPT_CALL_COUNT_WINDOW_MINUTES,
  getEnkryptCallCounts,
  recordEnkryptCalls,
  type EnkryptCallCountStore,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/call-counter';
import { enkryptCallsMinuteRedisKey } from '@kilocode/web-shared/lib/redis-keys';

jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: {}, deferredRedisClient: {} }));

function memoryStore() {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  let pipelines = 0;
  const store: EnkryptCallCountStore = {
    pipeline() {
      pipelines++;
      const commands: Array<() => void> = [];
      return {
        incrby(key: string, increment: number) {
          commands.push(() => counts.set(key, (counts.get(key) ?? 0) + increment));
        },
        expire(key: string, seconds: number) {
          commands.push(() => expiries.set(key, seconds));
        },
        async exec() {
          for (const command of commands) command();
        },
      };
    },
    async mget(keys: string[]) {
      return keys.map(key => (counts.has(key) ? String(counts.get(key)) : null));
    },
  };
  return { store, counts, expiries, pipelines: () => pipelines };
}

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 20, 12, 30, 45);
const MINUTE_OF_NOW = Math.floor(NOW / MINUTE);
const DETECT_URL = 'https://api.enkryptai.com/guardrails/detect';

describe('Enkrypt call counter', () => {
  afterEach(() => jest.useRealTimers());

  it('adds counts to their minute buckets in one pipeline, with a TTL past the read window', async () => {
    expect(ENKRYPT_CALL_COUNT_TTL_SECONDS).toBeGreaterThan(
      ENKRYPT_CALL_COUNT_WINDOW_MINUTES * 60 + 60
    );
    const { store, counts, expiries, pipelines } = memoryStore();
    await recordEnkryptCalls(
      new Map([
        [MINUTE_OF_NOW, 2],
        [MINUTE_OF_NOW + 1, 1],
      ]),
      store
    );
    await recordEnkryptCalls(new Map([[MINUTE_OF_NOW, 3]]), store);

    expect(Object.fromEntries(counts)).toEqual({
      [`enkrypt:calls:v1:${MINUTE_OF_NOW}`]: 5,
      [`enkrypt:calls:v1:${MINUTE_OF_NOW + 1}`]: 1,
    });
    expect([...expiries.values()]).toEqual([
      ENKRYPT_CALL_COUNT_TTL_SECONDS,
      ENKRYPT_CALL_COUNT_TTL_SECONDS,
    ]);
    expect(pipelines()).toBe(2);
  });

  it('writes nothing without calls', async () => {
    const { store, pipelines } = memoryStore();
    await recordEnkryptCalls(new Map(), store);
    expect(pipelines()).toBe(0);
  });

  it.each([
    ['fails', new Error('redis down')],
    ['times out', new DOMException('The operation timed out.', 'TimeoutError')],
  ])('never rejects when the write %s', async (_, error) => {
    const store: EnkryptCallCountStore = {
      pipeline: () => ({
        incrby: () => {},
        expire: () => {},
        exec: () => Promise.reject(error),
      }),
      mget: async () => [],
    };
    await expect(recordEnkryptCalls(new Map([[MINUTE_OF_NOW, 1]]), store)).resolves.toBeUndefined();
  });

  it('counts each fetch in the minute it starts, and writes them all on flush', async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['queueMicrotask', 'nextTick'] });
    const { store, counts, pipelines } = memoryStore();
    const response = new Response('{}');
    const baseFetch = jest.fn(async () => response);
    const counter = countEnkryptCalls(baseFetch as unknown as typeof fetch, store);

    await expect(counter.fetch(DETECT_URL, { method: 'POST' })).resolves.toBe(response);
    await counter.fetch(DETECT_URL, { method: 'POST' });
    jest.setSystemTime(NOW + MINUTE);
    await counter.fetch(DETECT_URL, { method: 'POST' });
    expect(pipelines()).toBe(0);

    await counter.flush();
    expect(baseFetch).toHaveBeenCalledTimes(3);
    expect(pipelines()).toBe(1);
    expect(Object.fromEntries(counts)).toEqual({
      [`enkrypt:calls:v1:${MINUTE_OF_NOW}`]: 2,
      [`enkrypt:calls:v1:${MINUTE_OF_NOW + 1}`]: 1,
    });

    await counter.flush();
    expect(pipelines()).toBe(1);
    await counter.fetch(DETECT_URL, { method: 'POST' });
    await counter.flush();
    expect(counts.get(`enkrypt:calls:v1:${MINUTE_OF_NOW + 1}`)).toBe(2);
  });

  it('returns the complete minutes before the current one, oldest first, zero when empty', async () => {
    const { store } = memoryStore();
    await recordEnkryptCalls(
      new Map([
        [MINUTE_OF_NOW - 3, 4],
        [MINUTE_OF_NOW - 1, 1],
        [MINUTE_OF_NOW, 7],
      ]),
      store
    );

    const counts = await getEnkryptCallCounts(NOW, 4, store);
    const currentStart = MINUTE_OF_NOW * MINUTE;
    expect(counts.bucketStarts).toEqual([
      currentStart - 4 * MINUTE,
      currentStart - 3 * MINUTE,
      currentStart - 2 * MINUTE,
      currentStart - MINUTE,
    ]);
    expect(counts.calls).toEqual([0, 4, 0, 1]);
  });
});

describe('Enkrypt call rate limiter', () => {
  const flushPromises = () => new Promise(resolve => setImmediate(resolve));

  function rateStore(values: Record<string, string | null> = {}) {
    const get = jest.fn(async (key: string) => values[key] ?? null);
    return { store: { get }, get, values };
  }

  it('admits calls up to the limit within a minute, counting its own', async () => {
    let now = NOW;
    const { store } = rateStore();
    const limiter = createEnkryptCallRateLimiter(store, () => now);

    expect([1, 2, 3].map(() => limiter.tryAcquire(2))).toEqual([true, true, false]);
    await flushPromises();
    now += 1_000;
    expect(limiter.tryAcquire(2)).toBe(false);
  });

  it('adds the shared count of the minute, read in the background from Redis', async () => {
    let now = NOW;
    const key = enkryptCallsMinuteRedisKey(Math.floor(NOW / MINUTE));
    const { store, get, values } = rateStore({ [key]: '8' });
    const limiter = createEnkryptCallRateLimiter(store, () => now);

    // The first decision does not wait for the read.
    expect(limiter.tryAcquire(10)).toBe(true);
    await flushPromises();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(key);

    // 8 shared calls, which do not yet include this instance's flushed call, plus its own one.
    expect(limiter.tryAcquire(10)).toBe(true);
    expect(limiter.tryAcquire(10)).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);

    // Once this instance's calls are flushed, a later read counts them only once.
    values[key] = '10';
    now += ENKRYPT_CALL_RATE_REFRESH_MS;
    limiter.tryAcquire(20);
    await flushPromises();
    expect(get).toHaveBeenCalledTimes(2);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(() => limiter.tryAcquire(20))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('starts every minute afresh', async () => {
    let now = NOW;
    const key = enkryptCallsMinuteRedisKey(Math.floor(NOW / MINUTE));
    const { store, get } = rateStore({ [key]: '100' });
    const limiter = createEnkryptCallRateLimiter(store, () => now);
    limiter.tryAcquire(5);
    await flushPromises();
    expect(limiter.tryAcquire(5)).toBe(false);

    now += MINUTE;
    expect(limiter.tryAcquire(5)).toBe(true);
    await flushPromises();
    expect(get).toHaveBeenLastCalledWith(enkryptCallsMinuteRedisKey(Math.floor(now / MINUTE)));
  });

  it('keeps admitting by its own count when Redis fails', async () => {
    const store = {
      get: jest.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const limiter = createEnkryptCallRateLimiter(store, () => NOW);

    expect(limiter.tryAcquire(2)).toBe(true);
    await flushPromises();
    expect(limiter.tryAcquire(2)).toBe(true);
    expect(limiter.tryAcquire(2)).toBe(false);
  });

  it('ignores a read that finishes after its minute ended', async () => {
    let now = NOW;
    const key = enkryptCallsMinuteRedisKey(Math.floor(NOW / MINUTE));
    let resolve: (value: string) => void = () => {};
    const store = {
      get: jest.fn(
        (requested: string) =>
          new Promise<string | null>(done => {
            if (requested === key) resolve = done;
            else done(null);
          })
      ),
    };
    const limiter = createEnkryptCallRateLimiter(store, () => now);
    limiter.tryAcquire(5);
    now += MINUTE;
    resolve('100');
    await flushPromises();

    expect(limiter.tryAcquire(5)).toBe(true);
  });
});
