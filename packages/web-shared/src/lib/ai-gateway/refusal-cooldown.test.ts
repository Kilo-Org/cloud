import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { redisClient } from '@/lib/redis';
import { refusalCooldownRedisKey, refusalCountRedisKey } from '@/lib/redis-keys';
import {
  getRefusalCooldownExpiry,
  isRefusalCooldownSubject,
  recordRefusal,
  REFUSAL_COOLDOWN_SECONDS,
  REFUSAL_COOLDOWN_THRESHOLD,
  REFUSAL_COUNT_WINDOW_SECONDS,
} from './refusal-cooldown';

type StoredValue = { value: string; expiresAtMs: number | null };

jest.mock('@/lib/redis', () => {
  const store = new Map<string, StoredValue>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    redisClient: {
      store,
      get: jest.fn(async (key: string) => live(key)?.value ?? null),
      set: jest.fn(async (key: string, value: string, opts: { ex: number; nx?: boolean }) => {
        if (opts.nx && live(key)) return null;
        store.set(key, { value, expiresAtMs: Date.now() + opts.ex * 1000 });
        return 'OK';
      }),
      incr: jest.fn(async (key: string) => {
        const entry = live(key);
        const next = Number(entry?.value ?? 0) + 1;
        store.set(key, { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
        return next;
      }),
      expire: jest.fn(async (key: string, seconds: number, option?: string) => {
        const entry = live(key);
        if (!entry) return 0;
        if (option === 'NX' && entry.expiresAtMs !== null) return 0;
        entry.expiresAtMs = Date.now() + seconds * 1000;
        return 1;
      }),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    },
  };
});

const fakeRedis = redisClient as unknown as typeof redisClient & {
  store: Map<string, StoredValue>;
};

const userId = 'refusal-user';

async function recordRefusals(count: number) {
  for (let i = 0; i < count; i++) {
    await recordRefusal(userId);
  }
}

describe('refusal cooldown', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    jest.useFakeTimers({ now: new Date('2026-10-02T12:00:00.000Z') });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('stays inactive below the refusal threshold', async () => {
    await recordRefusals(REFUSAL_COOLDOWN_THRESHOLD - 1);

    await expect(getRefusalCooldownExpiry(userId)).resolves.toBeNull();
  });

  test('starts a cooldown at the refusal threshold and resets the count', async () => {
    await recordRefusals(REFUSAL_COOLDOWN_THRESHOLD);

    await expect(getRefusalCooldownExpiry(userId)).resolves.toEqual(
      new Date(Date.now() + REFUSAL_COOLDOWN_SECONDS * 1000)
    );
    expect(fakeRedis.store.has(refusalCountRedisKey(userId))).toBe(false);
  });

  test('ends the cooldown when it expires', async () => {
    await recordRefusals(REFUSAL_COOLDOWN_THRESHOLD);

    jest.advanceTimersByTime(REFUSAL_COOLDOWN_SECONDS * 1000);

    await expect(getRefusalCooldownExpiry(userId)).resolves.toBeNull();
  });

  test('forgets refusals once the counting window passes', async () => {
    await recordRefusals(REFUSAL_COOLDOWN_THRESHOLD - 1);
    jest.advanceTimersByTime(REFUSAL_COUNT_WINDOW_SECONDS * 1000);
    await recordRefusals(1);

    await expect(getRefusalCooldownExpiry(userId)).resolves.toBeNull();
  });

  test('does not extend a running cooldown', async () => {
    await recordRefusals(REFUSAL_COOLDOWN_THRESHOLD);
    const firstExpiry = await getRefusalCooldownExpiry(userId);

    jest.advanceTimersByTime(10 * 60 * 1000);
    await recordRefusals(REFUSAL_COOLDOWN_THRESHOLD);

    await expect(getRefusalCooldownExpiry(userId)).resolves.toEqual(firstExpiry);
  });

  test('fails open when Redis is unavailable', async () => {
    jest.mocked(redisClient.get).mockRejectedValueOnce(new Error('timeout'));
    jest.mocked(redisClient.incr).mockRejectedValueOnce(new Error('timeout'));

    await expect(getRefusalCooldownExpiry(userId)).resolves.toBeNull();
    await expect(recordRefusal(userId)).resolves.toBeUndefined();
  });

  test('ignores an unparseable stored cooldown', async () => {
    fakeRedis.store.set(refusalCooldownRedisKey(userId), {
      value: 'not-a-date',
      expiresAtMs: null,
    });

    await expect(getRefusalCooldownExpiry(userId)).resolves.toBeNull();
  });
});

describe('isRefusalCooldownSubject', () => {
  test.each([
    ['personal Claude request', 'user-1', undefined, 'anthropic/claude-opus-5.5', true],
    ['personal GPT request', 'user-1', undefined, 'openai/gpt-6.1-sol', true],
    ['organization request', 'user-1', 'org-1', 'anthropic/claude-opus-5.5', false],
    ['other model', 'user-1', undefined, 'google/gemini-3-pro', false],
    ['gpt-oss model', 'user-1', undefined, 'openai/gpt-oss-120b', false],
    ['anonymous request', 'anon:127.0.0.1', undefined, 'anthropic/claude-opus-5.5', false],
  ])('%s', (_name, kiloUserId, organizationId, model, expected) => {
    expect(isRefusalCooldownSubject({ kiloUserId, organizationId, model })).toBe(expected);
  });
});
