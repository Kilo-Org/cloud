import {
  countEnkryptCalls,
  ENKRYPT_CALL_COUNT_TTL_SECONDS,
  getEnkryptCallCounts,
  recordEnkryptCalls,
  type EnkryptCallCountStore,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/call-counter';

jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: {} }));

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

  it('adds counts to their minute buckets in one pipeline, with a 24 hour TTL', async () => {
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

  it('never rejects when the write fails', async () => {
    const store: EnkryptCallCountStore = {
      pipeline: () => ({
        incrby: () => {},
        expire: () => {},
        exec: () => Promise.reject(new Error('redis down')),
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
