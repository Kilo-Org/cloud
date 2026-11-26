import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_FETCH_TIMEOUT_MS, BOOTSTRAP_RETRY_MS, createBootstrap } from '../src/bootstrap';
import { handOff, newCallScope } from '../src/flight';
import {
  JWKS_FETCH_TIMEOUT_MS,
  JWKS_MAX_RETRY_MS,
  JWKS_MAX_STALE_MS,
  JWKS_REFRESH_AFTER_MS,
  JWKS_RETRY_MS,
  JWKS_TTL_MS,
  createKeySetCache,
  importKeySet,
  type KeySetAges,
  type KeySetCache,
  type KeySetKind,
} from '../src/jwks';
import {
  SCOPE,
  STS_ISSUER,
  UTS_FEED_KID,
  UTS_ISSUER,
  UTS_TOKEN_KID,
  bearer,
  createIssuer,
  drain,
  fakeBootstrap,
  fakeFeed,
  fakeJwks,
  gate,
  harness,
  noJitter,
  sign,
  utsClaims,
  type FakeJwks,
  type Harness,
  type Issuer,
} from './helpers';
import type { RevocationFeed } from '../src/revocation';

// Design 5.7, 7 and Q55: the key-set ages. A UTS set counts its 5-minute lifetime and 4-minute
// refresh from `Age` and its 24-hour last-good limit from `Kilo-Key-Set-Oldest-Age`; an STS set
// counts its lifetime from `Age` alone.

const HOUR_S = 3_600;

let key: Issuer;
let other: Issuer;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
  noJitter();
  key = await createIssuer(UTS_ISSUER, UTS_TOKEN_KID);
  other = await createIssuer(UTS_ISSUER, UTS_TOKEN_KID);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

type Cache = { jwks: FakeJwks; keySet: KeySetCache };

function cache(kind: KeySetKind, ages: [number | null, number | null], keys = [key.jwk]): Cache {
  const jwks = fakeJwks(keys);
  [jwks.age, jwks.oldestAge] = ages;
  return { jwks, keySet: createKeySetCache(jwks.source, kind) };
}

/** One request's lookup of `kid`; `settled` ends once every fetch it started has answered. */
async function request(
  keySet: KeySetCache,
  kid: string
): Promise<{ status: string; settled: Promise<unknown> }> {
  const scope = newCallScope();
  const found = await keySet.key(kid, scope);
  const background: Promise<unknown>[] = [];
  handOff(scope, promise => background.push(promise));
  return { status: found.status, settled: Promise.all(background) };
}

async function lookup(keySet: KeySetCache, kid = key.kid): Promise<string> {
  const { status, settled } = await request(keySet, kid);
  await settled;
  return status;
}

describe('a UTS set counts its lifetime and refresh from Age', () => {
  // The set arrives 100 s old (refresh point at 140 s, expiry at 200 s); the issuer then drops
  // the key, so a synchronous refresh answers unknown_kid while a background one answers the key.
  it.each([
    ['uses it inside the refresh point', 139_999, 'key', 1],
    ['refreshes in the background at the refresh point', 140_000, 'key', 2],
    ['still answers from it before expiry', 199_999, 'key', 2],
    ['refreshes synchronously at expiry', 200_000, 'unknown_kid', 2],
  ])('%s', async (_name, after, status, calls) => {
    const c = cache('uts', [100, 100]);
    expect(await lookup(c.keySet)).toBe('key');
    c.jwks.keys = [];
    [c.jwks.age, c.jwks.oldestAge] = [0, 0];
    advance(after);
    expect(await lookup(c.keySet)).toBe(status);
    expect(c.jwks.calls).toBe(calls);
  });
});

describe('a UTS set counts its 24-hour limit from Kilo-Key-Set-Oldest-Age', () => {
  const limit = JWKS_MAX_STALE_MS - HOUR_S * 1000;
  it.each([
    ['serves the last good set just under the limit', limit - 1, 'key'],
    ['refuses it at the limit', limit, 'unavailable'],
  ])('%s', async (_name, after, status) => {
    const c = cache('uts', [0, HOUR_S]);
    expect(await lookup(c.keySet)).toBe('key');
    c.jwks.mode = 'fail';
    advance(after);
    expect(await lookup(c.keySet)).toBe(status);
  });
});

describe('the 24-hour limit is a refresh point', () => {
  // Newest keys fresh, oldest keys 1 s from the limit: nothing refreshes before it.
  it.each([
    ['refreshes at once and uses the new set', 'ok', 'key'],
    ['refuses the held set once that refresh fails', 'fail', 'unavailable'],
  ] as const)('%s', async (_name, mode, status) => {
    const c = cache('uts', [0, 24 * HOUR_S - 1]);
    expect(await lookup(c.keySet)).toBe('key');
    advance(999);
    expect(await lookup(c.keySet)).toBe('key');
    expect(c.jwks.calls).toBe(1);
    c.jwks.mode = mode;
    // The new set no longer holds the failing signer's keys.
    [c.jwks.age, c.jwks.oldestAge] = [0, 0];
    advance(1);
    expect(await lookup(c.keySet)).toBe(status);
    expect(c.jwks.calls).toBe(2);
  });

  it.each([
    ['refreshes at once inside a retry wait and refuses when that fails', 'fail', 'unavailable'],
    ['refreshes at once inside a retry wait and uses the new set', 'ok', 'key'],
  ] as const)('%s', async (_name, mode, status) => {
    // Refresh point at 1 s, the 24-hour limit at 10 s, expiry at 61 s.
    const c = cache('uts', [239, 24 * HOUR_S - 10]);
    expect(await lookup(c.keySet)).toBe('key');
    c.jwks.mode = 'fail';
    advance(1_000);
    expect(await lookup(c.keySet)).toBe('key'); // background refresh 2 fails: wait 5 s
    advance(5_000);
    expect(await lookup(c.keySet)).toBe('key'); // refresh 3 fails: wait 10 s, until 16 s
    expect(c.jwks.calls).toBe(3);
    c.jwks.mode = mode;
    [c.jwks.age, c.jwks.oldestAge] = [0, 0];
    advance(4_000);
    expect(await lookup(c.keySet)).toBe(status);
    expect(c.jwks.calls).toBe(4);
    advance(1_000);
    expect(await lookup(c.keySet)).toBe(status);
    expect(c.jwks.calls).toBe(4);
  });

  it('keeps doubling the retry wait past the limit, up to 60 s, until a success', async () => {
    const c = cache('uts', [0, 24 * HOUR_S - 1]);
    await lookup(c.keySet);
    c.jwks.mode = 'fail';
    advance(1_000);
    const waits: number[] = [];
    for (let failures = 1; failures <= 6; failures++) {
      const calls = c.jwks.calls;
      expect(await lookup(c.keySet)).toBe('unavailable');
      expect(c.jwks.calls).toBe(calls + 1);
      // The wait: no fetch one millisecond before it, the next fetch at it.
      const wait = Math.min(JWKS_MAX_RETRY_MS, JWKS_RETRY_MS * 2 ** (failures - 1));
      advance(wait - 1);
      expect(await lookup(c.keySet)).toBe('unavailable');
      expect(c.jwks.calls).toBe(calls + 1);
      advance(1);
      waits.push(wait);
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    // UTS answers again: the next fetch succeeds, and a later outage starts again at 5 s.
    c.jwks.mode = 'ok';
    [c.jwks.age, c.jwks.oldestAge] = [0, 0];
    expect(await lookup(c.keySet)).toBe('key');
    c.jwks.mode = 'fail';
    advance(JWKS_TTL_MS);
    const calls = c.jwks.calls;
    expect(await lookup(c.keySet)).toBe('key');
    advance(JWKS_RETRY_MS - 1);
    await lookup(c.keySet);
    expect(c.jwks.calls).toBe(calls + 1);
    advance(1);
    await lookup(c.keySet);
    expect(c.jwks.calls).toBe(calls + 2);
  });

  it('refreshes every isolate at the limit in the same millisecond, whatever its jitter', async () => {
    // Refresh points at 192 s and 288 s; the 24-hour limit of both comes first, at 100 s.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const early = cache('uts', [0, 24 * HOUR_S - 100]);
    await lookup(early.keySet);
    vi.spyOn(Math, 'random').mockReturnValue(1 - 2 ** -53);
    const late = cache('uts', [0, 24 * HOUR_S - 100]);
    await lookup(late.keySet);
    advance(99_999);
    await Promise.all([lookup(early.keySet), lookup(late.keySet)]);
    expect([early.jwks.calls, late.jwks.calls]).toEqual([1, 1]);
    advance(1);
    await Promise.all([lookup(early.keySet), lookup(late.keySet)]);
    expect([early.jwks.calls, late.jwks.calls]).toEqual([2, 2]);
  });
});

describe('a fetched UTS set past the refresh point is a failed refresh', () => {
  it('applies the retry wait after a stale answer to a background refresh', async () => {
    const c = cache('uts', [0, 0]);
    await lookup(c.keySet);
    [c.jwks.age, c.jwks.oldestAge] = [JWKS_REFRESH_AFTER_MS / 1000, JWKS_REFRESH_AFTER_MS / 1000];
    advance(JWKS_REFRESH_AFTER_MS);
    expect(await lookup(c.keySet)).toBe('key');
    expect(c.jwks.calls).toBe(2);
    advance(JWKS_RETRY_MS - 1);
    expect(await lookup(c.keySet)).toBe('key');
    expect(c.jwks.calls).toBe(2);
    advance(1);
    await lookup(c.keySet);
    expect(c.jwks.calls).toBe(3);
  });

  it('serves a stale set fetched at a cold start as the last good set, with the retry wait', async () => {
    const c = cache('uts', [400, 400]);
    expect(await lookup(c.keySet)).toBe('key');
    advance(JWKS_RETRY_MS - 1);
    expect(await lookup(c.keySet)).toBe('key');
    expect(c.jwks.calls).toBe(1);
    advance(1);
    expect(await lookup(c.keySet)).toBe('key');
    expect(c.jwks.calls).toBe(2);
  });
});

describe('missing or malformed UTS ages are a failed refresh, never fresh', () => {
  const rows: [string, number | null, number | null][] = [
    ['no ages', null, null],
    ['no oldest age', 30, null],
    ['no Age', null, 600],
    ['a negative Age', -1, 600],
    ['a fractional Age', 1.5, 600],
    ['an oldest age below Age', 30, 20],
    ['an Age past the safe integers', 2 ** 53, 2 ** 53],
  ];

  it.each(rows)('refuses a cold start with %s', async (_name, age, oldest) => {
    const c = cache('uts', [age, oldest]);
    expect(await lookup(c.keySet)).toBe('unavailable');
  });

  it.each(rows)('keeps the last good set and the retry wait on %s', async (_name, age, oldest) => {
    const c = cache('uts', [0, 0]);
    await lookup(c.keySet);
    c.jwks.keys = [];
    [c.jwks.age, c.jwks.oldestAge] = [age, oldest];
    advance(JWKS_TTL_MS);
    expect(await lookup(c.keySet)).toBe('key');
    advance(JWKS_RETRY_MS - 1);
    expect(await lookup(c.keySet)).toBe('key');
    expect(c.jwks.calls).toBe(2);
  });
});

describe('a late answer does not replace newer keys', () => {
  it('drops the answer of a timed-out fetch that arrives after a newer one', async () => {
    const c = cache('uts', [0, 0]);
    await lookup(c.keySet);
    advance(JWKS_TTL_MS);
    const held = gate();
    c.jwks.gate = held;
    const timedOut = request(c.keySet, key.kid);
    await vi.waitFor(() => expect(c.jwks.calls).toBe(2));
    advance(JWKS_FETCH_TIMEOUT_MS);
    const { status, settled: late } = await timedOut;
    expect(status).toBe('key');
    c.jwks.gate = null;
    c.jwks.keys = [other.jwk];
    advance(JWKS_RETRY_MS);
    expect(await lookup(c.keySet, other.kid)).toBe('key');
    // A second later the first fetch answers with the old key set, read before the second fetch.
    advance(1_000);
    c.jwks.keys = [key.jwk];
    held.release();
    await late;
    expect(await lookup(c.keySet, other.kid)).toBe('key');
    expect(c.jwks.calls).toBe(3);
  });
});

describe('install (the bootstrap)', () => {
  let feedA: Issuer;
  let feedB: Issuer;
  beforeEach(async () => {
    feedA = await createIssuer(UTS_ISSUER, UTS_FEED_KID);
    feedB = await createIssuer(UTS_ISSUER, UTS_FEED_KID);
  });

  // The held set was fetched now, 100 s old (oldest 1,000 s); `install` offers set B with these
  // ages, its call started `startedMs` from now.
  it.each<[string, KeySetAges, number, boolean]>([
    ['an older set does not replace it', { newest: 101, oldest: 1_001 }, 0, false],
    [
      'an older set from an earlier call does not replace it',
      { newest: 100, oldest: 1_000 },
      -1,
      false,
    ],
    ['the same newest read: the later load wins', { newest: 100, oldest: 1_000 }, 0, true],
    ['newer keys replace it', { newest: 99, oldest: 999 }, 0, true],
  ])('%s', async (_name, ages, startedMs, replaced) => {
    const c = cache('uts', [100, 1_000], [key.jwk, feedA.jwk]);
    await lookup(c.keySet);
    const setB = await importKeySet({ keys: [key.jwk, feedB.jwk] }, 'uts');
    c.keySet.install(setB, ages, Date.now() + startedMs, Date.now());
    expect(c.keySet.feedKey(feedA.kid, Date.now()) === null).toBe(replaced);
    expect(c.keySet.feedKey(feedB.kid, Date.now()) !== null).toBe(replaced);
  });

  it('does not hold a set already past its 24-hour limit', async () => {
    const c = cache('uts', [0, 0]);
    const keys = await importKeySet({ keys: [key.jwk] }, 'uts');
    c.keySet.install(keys, { newest: 0, oldest: 24 * HOUR_S }, Date.now(), Date.now());
    expect(c.keySet.cold()).toBe(true);
  });

  // The bootstrap call started 10 s ago and answered keys 200 s old (oldest 3,000 s): refresh
  // point 30 s from now, 24-hour limit 24 h - 3,010 s from now.
  it.each([
    ['uses it inside the refresh point', 29_999, 'ok', 'key', 0],
    ['refreshes in the background at the refresh point', 30_000, 'ok', 'key', 1],
    ['serves it just under the 24-hour limit', JWKS_MAX_STALE_MS - 3_010_001, 'fail', 'key', 1],
    ['refuses it at the limit', JWKS_MAX_STALE_MS - 3_010_000, 'fail', 'unavailable', 1],
  ] as const)(
    'counts the ages it was answered with: %s',
    async (_name, after, mode, status, calls) => {
      const c = cache('uts', [0, 0]);
      const keys = await importKeySet({ keys: [key.jwk] }, 'uts');
      c.keySet.install(keys, { newest: 200, oldest: 3_000 }, Date.now() - 10_000, Date.now());
      c.jwks.mode = mode;
      advance(after);
      expect(await lookup(c.keySet)).toBe(status);
      expect(c.jwks.calls).toBe(calls);
    }
  );
});

describe('the UTS bootstrap', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ bootstrap: true });
  });

  async function verifyUts() {
    return await h.verifier.verify(
      bearer(await sign(h.uts, utsClaims())),
      { issuer: 'uts', scope: SCOPE },
      h.ctx
    );
  }

  it('does not restart the age of a set a JWKS fetch loaded', async () => {
    // Bootstrap call 1 hangs past its timeout; call 2 loads the caches.
    const first = gate();
    h.bootstrap.gate = first;
    const timedOut = verifyUts();
    await vi.waitFor(() => expect(h.bootstrap.calls).toBe(1));
    advance(BOOTSTRAP_FETCH_TIMEOUT_MS);
    expect(await timedOut).toMatchObject({ status: 503, reason: 'bootstrap_unavailable' });
    const late = h.background.splice(0);
    h.bootstrap.gate = null;
    advance(BOOTSTRAP_RETRY_MS);
    expect(await verifyUts()).toMatchObject({ ok: true });
    // The 4-minute refresh fetches the key set: held keys now read at F.
    advance(JWKS_REFRESH_AFTER_MS);
    await verifyUts();
    await drain(h.background);
    expect(h.utsJwks.calls).toBe(1);
    // Three minutes on, call 1 answers: freshly read keys, but from a call older than F.
    advance(3 * 60_000);
    first.release();
    await Promise.all(late);
    // F + 4 minutes: the refresh point of the fetched set still holds.
    advance(60_000);
    await verifyUts();
    await drain(h.background);
    expect(h.utsJwks.calls).toBe(2);
  });

  it.each<[string, KeySetAges | null]>([
    ['no key ages', null],
    ['a negative age', { newest: -1, oldest: 0 }],
    ['an oldest age below the newest', { newest: 5, oldest: 4 }],
    ['an oldest age of 24 hours', { newest: 0, oldest: 24 * HOUR_S }],
  ])('refuses an answer with %s, applying nothing', async (_name, ages) => {
    h.bootstrap.ages = ages;
    expect(await verifyUts()).toMatchObject({ status: 503, reason: 'bootstrap_unavailable' });
    h.bootstrap.ages = { newest: 0, oldest: 0 };
    advance(BOOTSTRAP_RETRY_MS);
    expect(await verifyUts()).toMatchObject({ ok: true });
    expect([h.bootstrap.calls, h.utsJwks.calls, h.feed.calls]).toEqual([2, 0, 0]);
  });

  it('applies nothing when the key set passes its 24-hour limit during the call', async () => {
    // 1 s from the limit when the call starts, answered 2 s later.
    h.bootstrap.ages = { newest: 0, oldest: 24 * HOUR_S - 1 };
    const held = gate();
    h.bootstrap.gate = held;
    const pending = verifyUts();
    await vi.waitFor(() => expect(h.bootstrap.calls).toBe(1));
    advance(2_000);
    held.release();
    expect(await pending).toMatchObject({ status: 503, reason: 'bootstrap_unavailable' });
    // Nothing was installed: the next cold request bootstraps again, with no separate fetch.
    h.bootstrap.gate = null;
    h.bootstrap.ages = { newest: 0, oldest: 0 };
    advance(BOOTSTRAP_RETRY_MS);
    expect(await verifyUts()).toMatchObject({ ok: true });
    expect([h.bootstrap.calls, h.utsJwks.calls, h.feed.calls]).toEqual([2, 0, 0]);
  });
});

describe('a late bootstrap success', () => {
  it('does not clear the failure of a later attempt', async () => {
    const feedSigner = await createIssuer(UTS_ISSUER, UTS_FEED_KID);
    const jwks = fakeJwks([key.jwk, feedSigner.jwk]);
    const source = fakeBootstrap(jwks, fakeFeed(feedSigner));
    // Caches that stay cold after an install, so the bootstrap's own retry state stays visible.
    let installs = 0;
    const unused = () => {
      throw new Error('not used by the bootstrap');
    };
    const keySet: KeySetCache = {
      key: unused,
      ready: unused,
      feedKey: unused,
      prefetch: unused,
      cold: () => true,
      install: () => {
        installs++;
      },
    };
    const feed: RevocationFeed = { read: unused, cold: () => true, install: () => true };
    const bootstrap = createBootstrap(source.source, keySet, feed);

    // Attempt 1 hangs past its timeout; attempt 2, after the retry wait, fails at once.
    const late = gate();
    source.gate = late;
    const first = bootstrap.load(newCallScope());
    await vi.waitFor(() => expect(source.calls).toBe(1));
    advance(BOOTSTRAP_FETCH_TIMEOUT_MS);
    expect(await first).toMatchObject({ status: 'unavailable' });
    advance(BOOTSTRAP_RETRY_MS);
    source.gate = null;
    source.mode = 'fail';
    expect(await bootstrap.load(newCallScope())).toMatchObject({ status: 'unavailable' });
    expect(source.calls).toBe(2);

    // Attempt 1 now answers: it installs, but attempt 2's retry wait still holds.
    source.mode = 'ok';
    late.release();
    await vi.waitFor(() => expect(installs).toBe(1));
    bootstrap.prefetch(newCallScope());
    expect(source.calls).toBe(2);
    advance(BOOTSTRAP_RETRY_MS);
    bootstrap.prefetch(newCallScope());
    expect(source.calls).toBe(3);
  });
});

describe('jitter', () => {
  // Math.random() at its bounds and midpoint: ±20 % of the 4-minute refresh and the 5 s wait.
  it.each([
    [0, 192_000, 4_000],
    [0.5, 240_000, 5_000],
    [1 - 2 ** -53, 288_000, 6_000],
  ])('random %d: refresh point %d ms, retry wait %d ms', async (random, refreshMs, retryMs) => {
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const fresh = cache('uts', [0, 0]);
    await lookup(fresh.keySet);
    advance(refreshMs - 1);
    await lookup(fresh.keySet);
    expect(fresh.jwks.calls).toBe(1);
    advance(1);
    await lookup(fresh.keySet);
    expect(fresh.jwks.calls).toBe(2);

    const failing = cache('uts', [0, 0]);
    failing.jwks.mode = 'fail';
    expect(await lookup(failing.keySet)).toBe('unavailable');
    advance(retryMs - 1);
    await lookup(failing.keySet);
    expect(failing.jwks.calls).toBe(1);
    advance(1);
    await lookup(failing.keySet);
    expect(failing.jwks.calls).toBe(2);
  });
});

describe('an STS set', () => {
  let sts: Issuer;
  beforeEach(async () => {
    sts = await createIssuer(STS_ISSUER);
  });

  // The issuer fails after the first fetch, so the set serves exactly until its expiry.
  it.each<[string, number | null, number | null, number, string]>([
    ['without Age, serves until 5 minutes after its fetch', null, null, JWKS_TTL_MS - 1, 'key'],
    ['without Age, expires 5 minutes after its fetch', null, null, JWKS_TTL_MS, 'unavailable'],
    ['with Age, serves until 5 minutes after its read', 100, null, JWKS_TTL_MS - 100_001, 'key'],
    ['with Age, expires sooner', 100, null, JWKS_TTL_MS - 100_000, 'unavailable'],
    ['ignores an oldest age past 24 hours', 0, 24 * HOUR_S, JWKS_TTL_MS - 1, 'key'],
    ['ignores an oldest age below Age', 30, 0, JWKS_TTL_MS - 30_001, 'key'],
    ['never serves past its expiry', 0, 0, JWKS_TTL_MS, 'unavailable'],
  ])('%s', async (_name, age, oldest, after, status) => {
    const c = cache('sts', [age, oldest], [sts.jwk]);
    expect(await lookup(c.keySet, sts.kid)).toBe('key');
    c.jwks.mode = 'fail';
    advance(after);
    expect(await lookup(c.keySet, sts.kid)).toBe(status);
  });

  it.each<[string, number]>([
    ['a negative Age', -1],
    ['a fractional Age', 1.5],
  ])('counts %s as a failed refresh', async (_name, age) => {
    const c = cache('sts', [age, null], [sts.jwk]);
    expect(await lookup(c.keySet, sts.kid)).toBe('unavailable');
    advance(JWKS_RETRY_MS - 1);
    await lookup(c.keySet, sts.kid);
    expect(c.jwks.calls).toBe(1);
  });
});
