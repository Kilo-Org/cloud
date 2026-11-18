jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { eval: jest.fn() },
}));

import { captureException } from '@sentry/nextjs';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  claimPrRefresh,
  deferPrRefresh,
  type ClaimPrRefreshDenied,
  type ClaimPrRefreshInput,
} from './pr-refresh-budget';

type EvalFunction = (script: string, keys: string[], args: unknown[]) => Promise<unknown>;
type RedisEntry = { value: string; expiresAt: number };

const evalMock = redisClient.eval as unknown as jest.MockedFunction<EvalFunction>;
const captureExceptionMock = jest.mocked(captureException);

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const ATTEMPT_TTL_MS = 60_000;

const baseInput: ClaimPrRefreshInput = {
  appType: 'standard',
  installationId: 'installation-1',
  owner: { type: 'user', id: 'user-1' },
  repo: 'Kilo-Org/Kilo',
  number: 42,
};

let store: Map<string, RedisEntry>;

function liveEntry(key: string, now: number): RedisEntry | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function fakeEval(_script: string, keys: string[], args: unknown[]): Promise<unknown> {
  const now = Number(args[0]);

  if (keys.length === 2) {
    const [cooldownKey, attemptKey] = keys;
    const cooldown = liveEntry(cooldownKey, now);
    if (cooldown) {
      return Promise.resolve([0, 1, Number(cooldown.value)]);
    }

    const attempt = liveEntry(attemptKey, now);
    if (attempt) {
      return Promise.resolve([0, 2, Number(attempt.value)]);
    }

    const ttl = Number(args[1]);
    const deadline = now + ttl;
    store.set(attemptKey, { value: String(deadline), expiresAt: deadline });
    return Promise.resolve([1, 0, 0]);
  }

  const [cooldownKey] = keys;
  const target = Number(args[1]);
  const existing = liveEntry(cooldownKey, now);
  if (existing && Number(existing.value) >= target) {
    return Promise.resolve([1, Number(existing.value)]);
  }

  const ttl = Math.max(target - now, 1);
  store.set(cooldownKey, { value: String(target), expiresAt: now + ttl });
  return Promise.resolve([1, target]);
}

function lastEval() {
  const call = evalMock.mock.calls[evalMock.mock.calls.length - 1];
  if (!call) throw new Error('expected a Redis eval call');
  return { script: call[0], keys: call[1], args: call[2] };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  jest.clearAllMocks();
  store = new Map();
  evalMock.mockImplementation(fakeEval);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('claimPrRefresh', () => {
  it('uses namespaced cooldown and attempt keys with an exact 60 second attempt TTL', async () => {
    await claimPrRefresh(baseInput);

    const { script, keys, args } = lastEval();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^github:pr-refresh-budget:v1:cooldown:[0-9a-f]{64}$/);
    expect(keys[1]).toMatch(/^github:pr-refresh-budget:v1:attempt:[0-9a-f]{64}$/);
    expect(args).toEqual([T0, ATTEMPT_TTL_MS]);
    expect(script).toContain("'NX'");
    expect(script).toContain("'PX'");
    expect(script.indexOf("redis.call('GET', KEYS[1])")).toBeLessThan(
      script.indexOf("redis.call('SET', KEYS[2]")
    );
  });

  it('shares the cooldown key across tenants, repos, and PRs but not app types', async () => {
    const inputs: ClaimPrRefreshInput[] = [
      baseInput,
      { ...baseInput, owner: { type: 'org', id: 'org-1' } },
      { ...baseInput, repo: 'another/repo' },
      { ...baseInput, number: 43 },
      { ...baseInput, appType: 'lite' },
    ];
    const cooldownKeys: string[] = [];
    const attemptKeys: string[] = [];

    for (const input of inputs) {
      await claimPrRefresh(input);
      const { keys } = lastEval();
      cooldownKeys.push(keys[0]);
      attemptKeys.push(keys[1]);
    }

    const standardCooldownKeys = cooldownKeys.slice(0, 4);
    expect(new Set(standardCooldownKeys).size).toBe(1);
    expect(cooldownKeys[4]).not.toBe(cooldownKeys[0]);
    expect(new Set(attemptKeys).size).toBe(inputs.length);
  });

  it('keeps arbitrary owner IDs collision-safe and out of the key', async () => {
    const injected = { type: 'user' as const, id: 'id:with:colons\nand/slashes' };
    await claimPrRefresh({ ...baseInput, owner: injected });
    const first = lastEval().keys[1];

    await claimPrRefresh({
      ...baseInput,
      owner: { type: 'user', id: 'id' },
      repo: 'with:colons\nand/slashes',
    });
    const second = lastEval().keys[1];

    expect(first).not.toBe(second);
    expect(first).not.toContain('id:with:colons');
  });

  it('allows exactly one concurrent claim for the same tenant, repo, and PR', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => claimPrRefresh(baseInput)));

    const denied = results.filter((result): result is ClaimPrRefreshDenied => !result.allowed);
    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(denied).toHaveLength(19);

    for (const result of denied) {
      expect(result.reason).toBe('throttled');
      expect(result.retryAt).toBeInstanceOf(Date);
      expect(Number.isNaN(result.retryAt.getTime())).toBe(false);
      expect(result.retryAt.getTime()).toBe(T0 + ATTEMPT_TTL_MS);
    }
  });

  it('holds the attempt guard for exactly 60 seconds', async () => {
    await claimPrRefresh(baseInput);

    jest.setSystemTime(T0 + ATTEMPT_TTL_MS - 1);
    expect(await claimPrRefresh(baseInput)).toEqual({
      allowed: false,
      reason: 'throttled',
      retryAt: new Date(T0 + ATTEMPT_TTL_MS),
    });

    jest.setSystemTime(T0 + ATTEMPT_TTL_MS);
    expect(await claimPrRefresh(baseInput)).toEqual({ allowed: true });
  });

  it('returns the stored attempt deadline instead of extending it on repeated throttles', async () => {
    await claimPrRefresh(baseInput);
    jest.setSystemTime(T0 + 1_234);

    expect(await claimPrRefresh(baseInput)).toEqual({
      allowed: false,
      reason: 'throttled',
      retryAt: new Date(T0 + ATTEMPT_TTL_MS),
    });
  });

  it('shares an installation cooldown across tenant repositories and PRs', async () => {
    const resetAt = new Date(T0 + 120_000);
    await deferPrRefresh({
      appType: 'standard',
      installationId: 'installation-1',
      resetAt,
    });

    const { keys, args } = lastEval();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^github:pr-refresh-budget:v1:cooldown:[0-9a-f]{64}$/);
    expect(args).toEqual([T0, resetAt.getTime()]);

    const results = await Promise.all([
      claimPrRefresh(baseInput),
      claimPrRefresh({ ...baseInput, owner: { type: 'org', id: 'org-2' } }),
      claimPrRefresh({ ...baseInput, repo: 'another/repo', number: 9 }),
      claimPrRefresh({ ...baseInput, appType: 'lite' }),
    ]);

    for (const result of results.slice(0, 3)) {
      expect(result).toEqual({ allowed: false, reason: 'rate_limited', retryAt: resetAt });
    }
    expect(results[3]).toEqual({ allowed: true });
  });

  it('never shortens an existing cooldown and extends it monotonically', async () => {
    const longDeadline = new Date(T0 + 180_000);
    await deferPrRefresh({
      appType: 'standard',
      installationId: 'installation-1',
      resetAt: longDeadline,
    });
    await deferPrRefresh({
      appType: 'standard',
      installationId: 'installation-1',
      resetAt: new Date(T0 + 60_000),
    });

    const deferScript = lastEval().script;
    expect(deferScript).toContain('current >= target');
    expect(deferScript).toContain("'PX'");

    expect(await claimPrRefresh(baseInput)).toEqual({
      allowed: false,
      reason: 'rate_limited',
      retryAt: longDeadline,
    });

    const longerDeadline = new Date(T0 + 240_000);
    await deferPrRefresh({
      appType: 'standard',
      installationId: 'installation-1',
      resetAt: longerDeadline,
    });

    expect(await claimPrRefresh(baseInput)).toEqual({
      allowed: false,
      reason: 'rate_limited',
      retryAt: longerDeadline,
    });
  });

  it.each([null, undefined, 'allowed', {}, [1], [2, 0, 0], [0, 1, 'not-a-number'], [0, 3, T0]])(
    'fails closed for malformed Redis result %p',
    async raw => {
      evalMock.mockResolvedValueOnce(raw);

      const result = await claimPrRefresh(baseInput);
      expect(result).toEqual({
        allowed: false,
        reason: 'unavailable',
        retryAt: new Date(T0 + ATTEMPT_TTL_MS),
      });
      expect(evalMock).toHaveBeenCalledTimes(1);
    }
  );

  it('fails closed without granting work when Redis is unavailable', async () => {
    evalMock.mockRejectedValueOnce(new Error('redis down'));

    const result = await claimPrRefresh(baseInput);
    expect(result).toEqual({
      allowed: false,
      reason: 'unavailable',
      retryAt: new Date(T0 + ATTEMPT_TTL_MS),
    });
    expect(evalMock).toHaveBeenCalledTimes(1);
  });
});

describe('deferPrRefresh', () => {
  it('does not throw and reports a generic error when Redis fails', async () => {
    evalMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      deferPrRefresh({
        appType: 'standard',
        installationId: 'installation-1',
        resetAt: new Date(T0 + 120_000),
      })
    ).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [error, context] = captureExceptionMock.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Failed to defer GitHub PR refresh cooldown');
    expect(JSON.stringify(context ?? {})).not.toContain('installation-1');
    expect(JSON.stringify(context ?? {})).not.toContain('user-1');
  });

  it('does not throw and reports a generic error when Redis returns an invalid result', async () => {
    evalMock.mockResolvedValueOnce({ unexpected: true });

    await expect(
      deferPrRefresh({
        appType: 'standard',
        installationId: 'installation-1',
        resetAt: new Date(T0 + 120_000),
      })
    ).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
