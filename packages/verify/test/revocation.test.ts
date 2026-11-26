import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEED_FETCH_TIMEOUT_MS,
  FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS,
  FEED_MAX_FETCHED_HEAD_AGE_MS,
  FEED_MAX_FUTURE_MS,
  FEED_MAX_RETRY_MS,
  FEED_REFRESH_AFTER_MS,
  FEED_RETRY_MS,
  FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS,
  FEED_WAIT_AFTER_MS,
  type VerifyResult,
} from '../src/index';
import { maxHeadAgeForLifetime } from '../src/revocation';
import {
  SCOPE,
  UTS_FEED_KID,
  UTS_ISSUER,
  bearer,
  createIssuer,
  drain,
  emptyList,
  freezeHeartbeats,
  gate,
  harness,
  nowSeconds,
  sign,
  utsClaims,
  type Harness,
} from './helpers';

// Design 5.6 and 7: request-driven revalidation of the revocation feed, the head and list checks,
// and the head-age limits.

let h: Harness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
  h = await harness();
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** A UTS access token living `lifetimeSeconds`, issued now. */
async function verify(lifetimeSeconds = 600): Promise<VerifyResult> {
  const token = await sign(h.uts, utsClaims({ exp: nowSeconds() + lifetimeSeconds }));
  return await h.verifier.verify(bearer(token), { issuer: 'uts', scope: SCOPE }, h.ctx);
}

const unavailable = {
  ok: false,
  status: 503,
  error: 'temporarily_unavailable',
  reason: 'feed_unavailable',
};

describe('request-driven revalidation', () => {
  // `waits`: whether the request waits for the fetch it starts (held open by a gate) or answers
  // from its copy while the fetch runs in the background under its waitUntil.
  it.each([
    ['a request inside 10 s of the last fetch uses the copy', FEED_REFRESH_AFTER_MS - 1, 1, false],
    [
      'a request 10 s after the last fetch answers at once and refreshes in the background',
      FEED_REFRESH_AFTER_MS,
      2,
      false,
    ],
    ['a request with a head over 30 s old waits for the refresh', FEED_WAIT_AFTER_MS + 1, 2, true],
  ])('%s', async (_name, after, fetches, waits) => {
    expect(await verify()).toMatchObject({ ok: true });
    expect(h.feed.calls).toBe(1);
    advance(after);
    const held = gate();
    h.feed.gate = held;
    let settled = false;
    const pending = verify().then(result => {
      settled = true;
      return result;
    });
    if (waits) {
      await vi.waitFor(() => expect(h.feed.calls).toBe(fetches));
      expect(settled).toBe(false);
      held.release();
      expect(await pending).toMatchObject({ ok: true });
    } else {
      expect(await pending).toMatchObject({ ok: true });
      expect(h.background).toHaveLength(fetches - 1);
      held.release();
    }
    await drain(h.background);
    expect(h.feed.calls).toBe(fetches);
  });

  it('fetches the list only when the head names a new hash, and applies it', async () => {
    await verify();
    advance(FEED_REFRESH_AFTER_MS);
    await verify();
    await drain(h.background);
    expect(h.feed.listsSent).toBe(1);

    h.feed.list = { ...emptyList(), revokedSids: new Set(['grant-1']) };
    advance(FEED_REFRESH_AFTER_MS);
    await verify();
    await drain(h.background);
    expect(h.feed.listsSent).toBe(2);
    expect(await verify()).toMatchObject({ ok: false, status: 401, reason: 'revoked_session' });
  });

  it('merges concurrent cold reads into one fetch', async () => {
    h.feed.gate = gate();
    const pending = Array.from({ length: 10 }, () => verify());
    await vi.waitFor(() => expect(h.feed.calls).toBe(1));
    h.feed.gate.release();
    const results = await Promise.all(pending);
    expect(results.every(result => result.ok)).toBe(true);
    expect(h.feed.calls).toBe(1);
    expect(h.utsJwks.calls).toBe(1);
  });
});

describe('heads and lists that do not count', () => {
  it('counts a fetched head over 30 s old as a failed fetch', async () => {
    h.feed.headAgeMs = FEED_MAX_FETCHED_HEAD_AGE_MS + 1_000;
    expect(await verify()).toMatchObject(unavailable);
  });

  it('refuses a head older than the one it holds', async () => {
    const firstHeadAt = Date.now();
    await verify();
    advance(FEED_REFRESH_AFTER_MS);
    h.feed.headIssuedAt = firstHeadAt - 1_000;
    h.feed.list = { ...emptyList(), revokedSids: new Set(['grant-1']) };
    await verify();
    await drain(h.background);
    // The replayed head was dropped, so its list never applied.
    expect(await verify()).toMatchObject({ ok: true });
  });

  it('keeps the held list when a head of the same second covers another list', async () => {
    h.feed.headIssuedAt = Date.now();
    h.feed.list = { ...emptyList(), revokedSids: new Set(['grant-1']) };
    expect(await verify()).toMatchObject({ ok: false, reason: 'revoked_session' });
    // The other feed object signed, in the same second, a list without that revocation.
    h.feed.list = emptyList();
    advance(FEED_REFRESH_AFTER_MS);
    await verify();
    await drain(h.background);
    expect(h.feed.listsSent).toBe(2);
    expect(await verify()).toMatchObject({ ok: false, reason: 'revoked_session' });
    // A head of a later second decides, after the retry wait.
    h.feed.headIssuedAt = null;
    advance(FEED_RETRY_MS);
    await verify();
    await drain(h.background);
    expect(await verify()).toMatchObject({ ok: true });
  });

  it('answers 503 once a hung first fetch passes its 1 s timeout', async () => {
    h.feed.mode = 'hang';
    const pending = verify();
    await vi.waitFor(() => expect(h.feed.calls).toBe(1));
    advance(FEED_FETCH_TIMEOUT_MS);
    expect(await pending).toMatchObject(unavailable);
  });

  it.each<[string, (h: Harness) => Promise<void> | void]>([
    [
      'a head signed by a key the UTS key set does not hold',
      async h => {
        h.feed.signer = await createIssuer(UTS_ISSUER, UTS_FEED_KID);
      },
    ],
    [
      'a head signed by a UTS token key',
      h => {
        h.feed.signer = h.uts;
      },
    ],
    [
      'a head under a feed kid but signed by another key',
      async h => {
        h.feed.signer = { ...(await createIssuer(UTS_ISSUER)), kid: h.feedSigner.kid };
      },
    ],
    [
      'a head with a crit header',
      h => {
        h.feed.header = { crit: ['exp'] };
      },
    ],
    [
      'a head of another JWS type',
      h => {
        h.feed.header = { typ: 'at+jwt' };
      },
    ],
    [
      'list bytes that do not match the head hash',
      h => {
        h.feed.tamperList = true;
      },
    ],
  ])('counts %s as a failed fetch', async (_name, setup) => {
    await setup(h);
    expect(await verify()).toMatchObject(unavailable);
    expect(h.feed.calls).toBe(1);
  });
});

describe('heads from the future (design 5.6 clock skew)', () => {
  it('counts a head more than 5 s in the future as a failed fetch', async () => {
    // The design 5.6 clock skew is 5 s.
    expect(FEED_MAX_FUTURE_MS).toBe(5_000);
    h.feed.headIssuedAt = Date.now() + 6_000;
    expect(await verify()).toMatchObject(unavailable);
  });

  it('takes a head up to 5 s in the future, but ages it from its fetch time', async () => {
    h.feed.headIssuedAt = Date.now() + 5_000;
    expect(await verify(3600)).toMatchObject({ ok: true });
    h.feed.mode = 'fail';
    // A 1-hour token refuses 60 s after the fetch, not 65 s.
    advance(FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS + 1);
    expect(await verify(3600)).toMatchObject(unavailable);
  });
});

describe('head-age limits while the feed is down', () => {
  it.each([
    [
      'a 10-minute token accepts a head just under 10 minutes old',
      600,
      FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS,
      { ok: true },
    ],
    [
      'a 10-minute token refuses a head over 10 minutes old',
      600,
      FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS + 1,
      unavailable,
    ],
    [
      'a 1-hour CI token accepts a head 60 s old',
      3600,
      FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS,
      { ok: true },
    ],
    [
      'a 1-hour CI token refuses a head over 60 s old',
      3600,
      FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS + 1,
      unavailable,
    ],
  ])('%s', async (_name, lifetime, headAge, expected) => {
    await verify(lifetime);
    h.feed.mode = 'fail';
    advance(headAge);
    expect(await verify(lifetime)).toMatchObject(expected);
  });

  it('refuses a long-lived credential past 60 s even when the copy was just checked', async () => {
    await verify(3600);
    h.feed.mode = 'fail';
    advance(FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS - 1);
    expect(await verify(3600)).toMatchObject({ ok: true });
    advance(2);
    expect(await verify(3600)).toMatchObject(unavailable);
  });

  it('sends Retry-After until the next fetch and does not retry inside the backoff', async () => {
    await verify(3600);
    h.feed.mode = 'fail';
    advance(FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS + 1);
    const refused = await verify(3600);
    if (refused.ok) throw new Error('expected a failure');
    expect(refused.headers['retry-after']).toBe(String(FEED_RETRY_MS / 1000));
    const calls = h.feed.calls;
    await verify(3600);
    expect(h.feed.calls).toBe(calls);
  });

  it('doubles the retry wait per failure while the copy serves short tokens, up to 30 s', async () => {
    await verify();
    h.feed.mode = 'fail';
    advance(FEED_WAIT_AFTER_MS + 1);
    const waits: number[] = [];
    for (let failures = 1; failures <= 5; failures++) {
      const calls = h.feed.calls;
      expect(await verify()).toMatchObject({ ok: true });
      expect(h.feed.calls).toBe(calls + 1);
      const wait = Math.min(FEED_MAX_RETRY_MS, FEED_RETRY_MS * 2 ** (failures - 1));
      advance(wait - 1);
      await verify();
      expect(h.feed.calls).toBe(calls + 1);
      advance(1);
      waits.push(wait);
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
  });

  it('chooses the limit by token lifetime', () => {
    expect(maxHeadAgeForLifetime(600)).toBe(FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS);
    expect(maxHeadAgeForLifetime(601)).toBe(FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS);
  });
});

describe('a cancelled request', () => {
  it('cannot make the feed refetch sooner than its retry wait', async () => {
    await verify();
    freezeHeartbeats();
    h.feed.mode = 'hang';
    const token = await sign(h.uts, utsClaims());
    advance(FEED_REFRESH_AFTER_MS);
    // Each request starts or meets a background refresh that its cancelled owner never answers;
    // 1.5 s apart, past the 1 s abandonment mark, while the copy is under 30 s old.
    const windowMs = 18_000;
    const results: VerifyResult[] = [];
    for (let elapsed = 0; elapsed <= windowMs; elapsed += 1_500) {
      results.push(await h.verifier.verify(bearer(token), { issuer: 'uts', scope: SCOPE }, h.ctx));
      advance(1_500);
    }
    expect(results.every(result => result.ok)).toBe(true);
    // At most one fetch per retry wait: the cold fetch plus one per started 5 s.
    expect(h.feed.calls - 1).toBeLessThanOrEqual(Math.ceil(windowMs / FEED_RETRY_MS));
  });
});
