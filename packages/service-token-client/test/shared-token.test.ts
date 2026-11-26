import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  cacheTtlSeconds,
  SharedExchangedToken,
  type Exchange,
  type SharedCache,
  type SharedTokenResult,
  type SharedTokenSettings,
} from '../src/vercel/shared-token';

// The D10 algorithm `vercelIdentity` and the proof-run harness use, against stand-ins for
// the Runtime Cache and the exchange. Proof run 2 measures the real ones; this checks the logic.

const AUDIENCE = 'https://sts.test';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

const DEPLOYMENT = {
  owner_id: 'team_T1',
  project_id: 'prj_P1',
  environment: 'production',
  deployment_id: 'dpl_D1',
};

function baseToken(claims: Record<string, unknown> = {}): string {
  return unsignedJwt({ ...DEPLOYMENT, iat: nowSeconds(), exp: nowSeconds() + 7200, ...claims });
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

const BASE_TOKEN = baseToken();

/** A regional Runtime Cache stand-in: entries expire on their TTL, every call takes `latencyMs`. */
function fakeCache(latencyMs = 5): SharedCache {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get(key) {
      await sleep(latencyMs);
      const entry = entries.get(key);
      return entry !== undefined && entry.expiresAt > Date.now()
        ? structuredClone(entry.value)
        : null;
    },
    async set(key, value, { ttl }) {
      await sleep(latencyMs);
      entries.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttl * 1000 });
    },
  };
}

/** The exchange stand-in: `budget` tokens, then 429s, as proof run 1 saw about 100 per burst. */
function fakeExchange(options: {
  budget: number;
  exp?: number;
  answers?: ('rate_limited' | 'token')[];
}) {
  const calls = { attempts: 0, served: 0 };
  const exchange: Exchange = async base => {
    calls.attempts += 1;
    await sleep(50);
    const scripted = options.answers?.[calls.attempts - 1];
    if (scripted === 'rate_limited' || (scripted === undefined && calls.served >= options.budget)) {
      return { kind: 'rate_limited' };
    }
    calls.served += 1;
    const claims = claimsOf(base);
    return {
      kind: 'token',
      token: unsignedJwt({ ...claims, exp: options.exp ?? claims.exp, aud: AUDIENCE }),
    };
  };
  return { calls, exchange };
}

/** Cold instances: each starts with empty memory, and all share one cache. */
async function coldWave(
  instances: number,
  cache: SharedCache,
  exchange: Exchange,
  settings: Partial<SharedTokenSettings> = {},
  baseFor: (index: number) => string = () => BASE_TOKEN
): Promise<SharedTokenResult[]> {
  return await Promise.all(
    Array.from({ length: instances }, (_, index) =>
      new SharedExchangedToken(cache, { settings }).get(baseFor(index), AUDIENCE, exchange)
    )
  );
}

function total(results: readonly SharedTokenResult[], key: 'rateLimited' | 'exchangeAttempts') {
  return results.reduce((sum, result) => sum + result.report[key], 0);
}

describe('shared exchanged token (D10)', () => {
  it('serves a 2,500-instance cold wave with about one exchange and no 429', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const results = await coldWave(2_500, fakeCache(), exchange);
    expect(results.every(result => result.status === 'ok')).toBe(true);
    expect(calls.attempts).toBeLessThanOrEqual(3);
    expect(total(results, 'rateLimited')).toBe(0);
    const slowest = Math.max(...results.map(result => result.report.timeToTokenMs));
    expect(slowest).toBeLessThan(3_000);
  }, 15_000);

  it('without claims, exceeds the budget but still serves every instance from the cache after a 429', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const results = await coldWave(2_500, fakeCache(), exchange, { claim: false });
    expect(results.every(result => result.status === 'ok')).toBe(true);
    expect(calls.attempts).toBeGreaterThan(100);
    expect(calls.served).toBe(100);
    expect(total(results, 'rateLimited')).toBe(calls.attempts - 100);
  }, 15_000);

  it('does not exchange again after a 429 until the claim marker expires', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100, answers: ['rate_limited'] });
    const results = await coldWave(50, fakeCache(), exchange, {
      claimTtlSeconds: 1,
      deadlineMs: 5_000,
    });
    expect(results.every(result => result.status === 'ok')).toBe(true);
    expect(calls.attempts).toBe(2);
    expect(total(results, 'rateLimited')).toBe(1);
  }, 15_000);

  it('keeps a token with 5 minutes left until 60 seconds before exp, without re-exchanging', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100, exp: nowSeconds() + 300 });
    const cache = fakeCache();
    const instance = new SharedExchangedToken(cache, { settings: { jitterMs: 1 } });
    expect((await instance.get(BASE_TOKEN, AUDIENCE, exchange)).report.source).toBe('exchanged');
    expect((await instance.get(BASE_TOKEN, AUDIENCE, exchange)).report.source).toBe('memory');
    const another = new SharedExchangedToken(cache, { settings: { jitterMs: 1 } });
    expect((await another.get(BASE_TOKEN, AUDIENCE, exchange)).report.source).toBe('cache');
    expect(calls.attempts).toBe(1);
  });

  it('computes the cache lifetime as exp minus 60 seconds, with no refresh margin', () => {
    const now = nowSeconds();
    expect(cacheTtlSeconds(now + 7200, now)).toBe(7140);
    expect(cacheTtlSeconds(now + 300, now)).toBe(240);
    expect(cacheTtlSeconds(now + 30, now)).toBeNull();
  });

  it('on a miss, fails at once with no exchange and no waiting when the base token has under 60 s left', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const expiring = baseToken({ iat: nowSeconds() - 7150, exp: nowSeconds() + 50 });
    const result = await new SharedExchangedToken(fakeCache()).get(expiring, AUDIENCE, exchange);
    expect(result).toMatchObject({
      status: 'failed',
      detail: 'the base token expires within 60 seconds',
      report: { exchangeAttempts: 0, cacheReads: 1, waitedMs: 0 },
    });
    expect(calls.attempts).toBe(0);
  });

  it('keeps one key when Vercel renews the base token mid-wave', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const renewed = baseToken({ iat: nowSeconds() + 33, exp: nowSeconds() + 7233 });
    const cache = fakeCache();
    const keys = new Set<string>();
    const recording: SharedCache = {
      get: async key => {
        if (!key.endsWith(':claim')) keys.add(key);
        return await cache.get(key);
      },
      set: async (key, value, options) => await cache.set(key, value, options),
    };
    const results = await coldWave(2_500, recording, exchange, {}, index =>
      index % 2 === 0 ? BASE_TOKEN : renewed
    );
    expect(keys.size).toBe(1);
    expect(results.every(result => result.status === 'ok')).toBe(true);
    expect(calls.attempts).toBeLessThanOrEqual(3);
    expect(total(results, 'rateLimited')).toBe(0);
    const slowest = Math.max(...results.map(result => result.report.timeToTokenMs));
    expect(slowest).toBeLessThan(3_000);
  }, 15_000);

  it('serves a still-valid cached token to an instance holding a newer base token', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const cache = fakeCache();
    await new SharedExchangedToken(cache).get(BASE_TOKEN, AUDIENCE, exchange);
    const renewed = baseToken({ iat: nowSeconds() + 600, exp: nowSeconds() + 7800 });
    const later = await new SharedExchangedToken(cache).get(renewed, AUDIENCE, exchange);
    expect(later.report.source).toBe('cache');
    expect(calls.attempts).toBe(1);
  });

  it('keys deployments apart and ignores a cached token of another deployment', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const shared = new Map<string, unknown>();
    const cache: SharedCache = {
      get: async key => shared.get(key) ?? null,
      set: async (key, value) => void shared.set(key, value),
    };
    await new SharedExchangedToken(cache).get(BASE_TOKEN, AUDIENCE, exchange);
    const other = baseToken({ deployment_id: 'dpl_D2' });
    const result = await new SharedExchangedToken(cache).get(other, AUDIENCE, exchange);
    expect(result.report.source).toBe('exchanged');
    expect(calls.attempts).toBe(2);

    // An entry written under this deployment's key with another deployment's token is a miss.
    for (const stored of shared.keys()) if (stored.endsWith(':claim')) shared.delete(stored);
    const [key = ''] = shared.keys();
    const foreign = unsignedJwt({
      ...DEPLOYMENT,
      deployment_id: 'dpl_D9',
      exp: nowSeconds() + 7200,
      aud: AUDIENCE,
    });
    shared.set(key, { token: foreign, exp: nowSeconds() + 7200 });
    const third = await new SharedExchangedToken(cache, { settings: { jitterMs: 1 } }).get(
      BASE_TOKEN,
      AUDIENCE,
      exchange
    );
    expect(third.status === 'ok' && claimsOf(third.token).deployment_id).toBe('dpl_D1');
  });

  it('fails a base token without the deployment claims', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const bare = unsignedJwt({ iat: nowSeconds(), exp: nowSeconds() + 7200 });
    const result = await new SharedExchangedToken(fakeCache()).get(bare, AUDIENCE, exchange);
    expect(result).toMatchObject({
      status: 'failed',
      detail: 'the base token lacks a deployment claim',
    });
    expect(calls.attempts).toBe(0);
  });

  it('does not share entries between key prefixes, in the cache or in memory', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const cache = fakeCache();
    const instance = new SharedExchangedToken(cache, { settings: { jitterMs: 1 } });
    const first = await instance.get(BASE_TOKEN, AUDIENCE, exchange, { keyPrefix: 'run-a' });
    expect(first.report.source).toBe('exchanged');
    const again = await instance.get(BASE_TOKEN, AUDIENCE, exchange, { keyPrefix: 'run-a' });
    expect(again.report.source).toBe('memory');
    const otherRun = await instance.get(BASE_TOKEN, AUDIENCE, exchange, { keyPrefix: 'run-b' });
    expect(otherRun.report.source).toBe('exchanged');
    const otherInstance = new SharedExchangedToken(cache, { settings: { jitterMs: 1 } });
    const fromCache = await otherInstance.get(BASE_TOKEN, AUDIENCE, exchange, {
      keyPrefix: 'run-b',
    });
    expect(fromCache.report.source).toBe('cache');
    expect(calls.attempts).toBe(2);
  });

  it('exchanges once per instance when the cache keeps nothing', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const nothing: SharedCache = { get: async () => null, set: async () => {} };
    const results = await coldWave(10, nothing, exchange, { jitterMs: 1 });
    expect(results.every(result => result.status === 'ok')).toBe(true);
    expect(calls.attempts).toBe(10);
  });

  it('fails at once on a 429 when the cache keeps nothing, instead of polling to the deadline', async () => {
    const { calls, exchange } = fakeExchange({ budget: 0 });
    const nothing: SharedCache = { get: async () => null, set: async () => {} };
    const [result] = await coldWave(1, nothing, exchange, { jitterMs: 1, deadlineMs: 5_000 });
    expect(result).toMatchObject({
      status: 'failed',
      detail: 'the exchange answered 429 and the shared cache keeps nothing',
      report: { exchangeAttempts: 1, rateLimited: 1 },
    });
    expect(result?.report.timeToTokenMs).toBeLessThan(1_000);
    expect(calls.attempts).toBe(1);
  });

  it('fails at the deadline when no token arrives', async () => {
    const { exchange } = fakeExchange({ budget: 0 });
    const [result] = await coldWave(1, fakeCache(), exchange, { jitterMs: 1, deadlineMs: 300 });
    expect(result).toMatchObject({
      status: 'failed',
      detail: 'no token before the deadline',
      report: { exchangeAttempts: 1, rateLimited: 1 },
    });
  });
});
