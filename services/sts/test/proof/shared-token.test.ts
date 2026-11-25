import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  cacheTtlSeconds,
  SharedExchangedToken,
  type Exchange,
  type SharedCache,
  type SharedTokenResult,
  type SharedTokenSettings,
} from '../../proof/vercel-exchange/lib/shared-token';

// The D10 algorithm the proof-run harness (and later the Vercel client) uses, against stand-ins for
// the Runtime Cache and the exchange. Proof run 2 measures the real ones; this checks the logic.

const AUDIENCE = 'https://sts.test';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

const BASE_TOKEN = unsignedJwt({ iat: nowSeconds(), exp: nowSeconds() + 7200 });

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
  const exchange: Exchange = async () => {
    calls.attempts += 1;
    await sleep(50);
    const scripted = options.answers?.[calls.attempts - 1];
    if (scripted === 'rate_limited' || (scripted === undefined && calls.served >= options.budget)) {
      return { kind: 'rate_limited' };
    }
    calls.served += 1;
    const exp = options.exp ?? nowSeconds() + 7200;
    return { kind: 'token', token: unsignedJwt({ exp, aud: AUDIENCE }) };
  };
  return { calls, exchange };
}

/** Cold instances: each starts with empty memory, and all share one cache. */
async function coldWave(
  instances: number,
  cache: SharedCache,
  exchange: Exchange,
  settings: Partial<SharedTokenSettings> = {}
): Promise<SharedTokenResult[]> {
  return await Promise.all(
    Array.from({ length: instances }, () =>
      new SharedExchangedToken(cache, { settings }).get(BASE_TOKEN, AUDIENCE, exchange)
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

  it('keeps a fresh token with under 10 minutes left until 60 seconds before exp', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100, exp: nowSeconds() + 300 });
    const cache = fakeCache();
    const instance = new SharedExchangedToken(cache, { settings: { jitterMs: 1 } });
    expect((await instance.get(BASE_TOKEN, AUDIENCE, exchange)).report.source).toBe('exchanged');
    expect((await instance.get(BASE_TOKEN, AUDIENCE, exchange)).report.source).toBe('memory');
    const another = new SharedExchangedToken(cache, { settings: { jitterMs: 1 } });
    expect((await another.get(BASE_TOKEN, AUDIENCE, exchange)).report.source).toBe('cache');
    expect(calls.attempts).toBe(1);
  });

  it('computes the cache lifetime from exp', () => {
    const now = nowSeconds();
    expect(cacheTtlSeconds(now + 7200, now)).toBe(6600);
    expect(cacheTtlSeconds(now + 300, now)).toBe(240);
    expect(cacheTtlSeconds(now + 30, now)).toBeNull();
  });

  it('exchanges once per instance when the cache keeps nothing', async () => {
    const { calls, exchange } = fakeExchange({ budget: 100 });
    const nothing: SharedCache = { get: async () => null, set: async () => {} };
    const results = await coldWave(10, nothing, exchange, { jitterMs: 1 });
    expect(results.every(result => result.status === 'ok')).toBe(true);
    expect(calls.attempts).toBe(10);
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
