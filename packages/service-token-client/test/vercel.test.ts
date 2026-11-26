import type { MintRequest } from '@kilocode/sts-contracts';
import { describe, expect, it, vi } from 'vitest';
import { DENIED_RECHECK_MS } from '../src/client';
import { createHttpServiceTokens } from '../src/http';
import {
  VERCEL_EXCHANGE_URL,
  vercelExchange,
  vercelIdentity,
  type Exchange,
  type SharedCache,
} from '../src/vercel';

const STS = 'https://sts.test';

function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const DEPLOYMENT = {
  owner_id: 'team_T1',
  project_id: 'prj_P1',
  environment: 'production',
  deployment_id: 'dpl_D1',
};

function memoryCache(): SharedCache {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      return entry !== undefined && entry.expiresAt > Date.now()
        ? structuredClone(entry.value)
        : null;
    },
    async set(key, value, { ttl }) {
      entries.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttl * 1000 });
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

/** Exchanges for `aud`, keeping the base token's claims and `exp`, like Vercel. */
function exchangeLikeVercel(): { exchange: Exchange; calls: string[] } {
  const calls: string[] = [];
  const exchange: Exchange = async (baseToken, audience) => {
    calls.push(audience);
    const claims = JSON.parse(Buffer.from(baseToken.split('.')[1] ?? '', 'base64url').toString());
    return { kind: 'token', token: unsignedJwt({ ...claims, aud: audience }) };
  };
  return { exchange, calls };
}

describe('vercelIdentity', () => {
  it('reads the base token per call, never when it is created', async () => {
    const getBaseToken = vi.fn(async () =>
      unsignedJwt({ ...DEPLOYMENT, iat: nowSeconds(), exp: nowSeconds() + 7200 })
    );
    const { exchange } = exchangeLikeVercel();
    const identity = vercelIdentity({
      stsAudience: STS,
      cache: memoryCache(),
      getBaseToken,
      exchange,
    });
    expect(getBaseToken).not.toHaveBeenCalled();
    await identity();
    await identity();
    expect(getBaseToken).toHaveBeenCalledTimes(2);
  });

  it('keeps the exchanged token until 60 seconds before its exp, then exchanges again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 10, 26, 12, 0, 0));
      const exp = nowSeconds() + 900;
      const base = unsignedJwt({ ...DEPLOYMENT, iat: nowSeconds(), exp });
      const { exchange, calls } = exchangeLikeVercel();
      const identity = vercelIdentity({
        stsAudience: STS,
        cache: memoryCache(),
        getBaseToken: async () => base,
        exchange,
        settings: { jitterMs: 1, settleMs: 1 },
      });

      const first = await identity();
      expect(JSON.parse(Buffer.from(first.split('.')[1], 'base64url').toString())).toMatchObject({
        aud: STS,
        exp,
      });
      vi.setSystemTime((exp - 61) * 1000);
      expect(await identity()).toBe(first);
      expect(calls).toEqual([STS]);

      // Under 60 s left: the token is no longer used, and a base token this close to exp fails fast.
      vi.setSystemTime((exp - 59) * 1000);
      await expect(identity()).rejects.toThrow('the base token expires within 60 seconds');
      expect(calls).toEqual([STS]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the call with the algorithm detail, never a token', async () => {
    const identity = vercelIdentity({
      stsAudience: STS,
      cache: memoryCache(),
      getBaseToken: async () => unsignedJwt({ iat: nowSeconds(), exp: nowSeconds() + 7200 }),
      exchange: exchangeLikeVercel().exchange,
    });
    await expect(identity()).rejects.toThrow(
      'no Vercel token for the STS audience: the base token lacks a deployment claim'
    );
  });
});

describe('a shared-cache identity STS refuses (identity_rejected)', () => {
  const INGEST = { audience: 'usage-ingest', scope: 'usage-ingest:sts.canary' };

  /** A cache that answers `poisoned` for the token key until that key is deleted. */
  function poisonedCache(poisoned: string) {
    const inner = memoryCache();
    let entry: { token: string; exp: number } | null = {
      token: poisoned,
      exp: JSON.parse(Buffer.from(poisoned.split('.')[1], 'base64url').toString()).exp,
    };
    const cache: SharedCache = {
      get: async key => (!key.endsWith(':claim') && entry !== null ? entry : await inner.get(key)),
      set: async (key, value, options) => await inner.set(key, value, options),
      delete: async key => {
        if (!key.endsWith(':claim')) entry = null;
        await inner.delete(key);
      },
    };
    return cache;
  }

  /** STS stand-in: refuses the identity tokens `refuses` names, issues for every other one. */
  function sts(refuses: (identity: string) => boolean) {
    const presented: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const identity =
        new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
      presented.push(identity);
      if (refuses(identity)) return Response.json({ status: 'identity_rejected' }, { status: 401 });
      const request = JSON.parse(init?.body as string) as MintRequest;
      return Response.json({
        status: 'ok',
        tokens: request.tokens.map(({ audience, scope }) => ({
          status: 'issued',
          audience,
          scope,
          token: `${scope}#${presented.length}`,
          jti: `jti-${presented.length}`,
          expiresAt: nowSeconds() + 300,
        })),
      });
    });
    return { fetchFn, presented };
  }

  function setup(refuses: (identity: string) => boolean) {
    const base = unsignedJwt({ ...DEPLOYMENT, iat: nowSeconds(), exp: nowSeconds() + 7200 });
    const poisoned = `${unsignedJwt({ ...DEPLOYMENT, aud: STS, iat: nowSeconds(), exp: nowSeconds() + 3600 }).slice(0, -'signature'.length)}forged`;
    const { exchange, calls } = exchangeLikeVercel();
    const { fetchFn, presented } = sts(identity => identity === poisoned || refuses(identity));
    const tokens = createHttpServiceTokens({
      stsUrl: STS,
      getIdentityToken: vercelIdentity({
        stsAudience: STS,
        cache: poisonedCache(poisoned),
        getBaseToken: async () => base,
        exchange,
        settings: { jitterMs: 1, settleMs: 1 },
      }),
      fetch: fetchFn as typeof fetch,
    });
    return { tokens, exchanges: calls, presented, poisoned };
  }

  async function settled<T>(promise: Promise<T>): Promise<T | unknown> {
    const outcome = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    return await outcome;
  }

  it('drops the poisoned entry and exchanges once more in the same attempt', async () => {
    vi.useFakeTimers();
    try {
      const { tokens, exchanges, presented, poisoned } = setup(() => false);
      expect(await settled(tokens.get(INGEST))).toBe('usage-ingest:sts.canary#2');
      expect(exchanges).toEqual([STS]);
      expect(presented).toHaveLength(2);
      expect(presented[0]).toBe(poisoned);
      expect(presented[1]).not.toBe(poisoned);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not loop: one re-exchange per refusal, then the denial holds until the recheck', async () => {
    vi.useFakeTimers();
    try {
      const { tokens, exchanges, presented } = setup(() => true);
      expect(await settled(tokens.get(INGEST))).toMatchObject({
        reason: 'denied',
        deniedReason: 'identity_rejected',
      });
      expect(exchanges).toEqual([STS]);
      expect(presented).toHaveLength(2);

      // Within the recheck window: no STS call, no exchange.
      await settled(tokens.get(INGEST));
      expect(presented).toHaveLength(2);

      // The recheck presents the token this instance exchanged itself: refused, kept, not re-exchanged.
      await vi.advanceTimersByTimeAsync(DENIED_RECHECK_MS);
      expect(await settled(tokens.get(INGEST))).toMatchObject({ reason: 'denied' });
      expect(presented).toHaveLength(3);
      expect(exchanges).toEqual([STS]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('vercelExchange', () => {
  function answering(response: Response) {
    const requests: { url: string; body: unknown }[] = [];
    // The exchange posts a string URL and a JSON string body.
    const fetchFn = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(init?.body as string) });
      return response;
    }) as typeof fetch;
    return { fetchFn, requests };
  }

  it('posts the base token and audience to the exchange and returns its token', async () => {
    const { fetchFn, requests } = answering(Response.json({ token: 'exchanged' }));
    expect(await vercelExchange(fetchFn)('base', STS)).toEqual({
      kind: 'token',
      token: 'exchanged',
    });
    expect(requests).toEqual([{ url: VERCEL_EXCHANGE_URL, body: { token: 'base', aud: STS } }]);
  });

  it('tells a 429 from other failures and never returns the error body', async () => {
    expect(
      await vercelExchange(answering(new Response('slow down', { status: 429 })).fetchFn)('b', STS)
    ).toEqual({
      kind: 'rate_limited',
    });
    expect(
      await vercelExchange(
        answering(new Response('{"error":"base.payload.sig"}', { status: 401 })).fetchFn
      )('b', STS)
    ).toEqual({ kind: 'failed', detail: 'the exchange answered 401' });
    expect(await vercelExchange(answering(Response.json({})).fetchFn)('b', STS)).toEqual({
      kind: 'failed',
      detail: 'the exchange answered no token',
    });
  });
});
