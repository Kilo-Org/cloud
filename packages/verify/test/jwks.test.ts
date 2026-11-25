import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JWKS_FETCH_TIMEOUT_MS,
  JWKS_MAX_RETRY_MS,
  JWKS_MAX_STALE_MS,
  JWKS_REFRESH_AFTER_MS,
  JWKS_RETRY_MS,
  JWKS_STALE_WAIT_MS,
  JWKS_TTL_MS,
  UNKNOWN_KID_REFRESH_INTERVAL_MS,
  httpJwksSource,
  type VerifyResult,
} from '../src/index';
import { importKeySet } from '../src/jwks';
import {
  SCOPE,
  STS_ISSUER,
  UTS_FEED_KID,
  UTS_ISSUER,
  UTS_TOKEN_KID,
  bearer,
  createIssuer,
  drain,
  fakeAllTimers,
  freezeHeartbeats,
  gate,
  harness,
  sign,
  stsClaims,
  utsClaims,
  type Harness,
  type Issuer,
} from './helpers';

// Design 7 key-set caching and fail-closed rules, through the verifier (STS routes unless named).

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

async function verifyWith(issuer: Issuer): Promise<VerifyResult> {
  return await h.verifier.verify(
    bearer(await sign(issuer, stsClaims())),
    { issuer: 'sts', scope: SCOPE },
    h.ctx
  );
}

const verify = () => verifyWith(h.sts);

describe('key-set lifetime', () => {
  // `waits`: whether the request waits for the fetch it starts (held open by a gate) or answers
  // from the cache while the fetch runs in the background under its waitUntil.
  it.each([
    ['a request inside 4 minutes uses the cache', JWKS_REFRESH_AFTER_MS - 1, 1, false],
    [
      'a request after 4 minutes answers at once and refreshes in the background',
      JWKS_REFRESH_AFTER_MS,
      2,
      false,
    ],
    ['a request after expiry waits for a synchronous refresh', JWKS_TTL_MS, 2, true],
  ])('%s', async (_name, after, fetches, waits) => {
    expect(await verify()).toMatchObject({ ok: true });
    expect(h.stsJwks.calls).toBe(1);
    advance(after);
    const held = gate();
    h.stsJwks.gate = held;
    let settled = false;
    const pending = verify().then(result => {
      settled = true;
      return result;
    });
    if (waits) {
      await vi.waitFor(() => expect(h.stsJwks.calls).toBe(fetches));
      expect(settled).toBe(false);
      held.release();
      expect(await pending).toMatchObject({ ok: true });
    } else {
      expect(await pending).toMatchObject({ ok: true });
      expect(h.background).toHaveLength(fetches - 1);
      held.release();
    }
    await drain(h.background);
    expect(h.stsJwks.calls).toBe(fetches);
  });

  it('starts only one background refresh for many requests after 4 minutes', async () => {
    await verify();
    advance(JWKS_REFRESH_AFTER_MS);
    h.stsJwks.gate = gate();
    const results = await Promise.all(Array.from({ length: 5 }, () => verify()));
    expect(results.every(result => result.ok)).toBe(true);
    expect(h.stsJwks.calls).toBe(2);
    expect(h.background).toHaveLength(1);
    h.stsJwks.gate.release();
    await drain(h.background);
  });

  it('drops a key the issuer removed at the next refresh', async () => {
    await verify();
    h.stsJwks.keys = [];
    advance(JWKS_TTL_MS);
    expect(await verify()).toMatchObject({ ok: false, status: 401, reason: 'unknown_kid' });
  });
});

describe('the last good set while the issuer is unreachable', () => {
  // A UTS rule: an STS set never serves past its 5-minute lifetime (last test of this block).
  async function verifyUtsWith(issuer: Issuer): Promise<VerifyResult> {
    return await h.verifier.verify(
      bearer(await sign(issuer, utsClaims())),
      { issuer: 'uts', scope: SCOPE },
      h.ctx
    );
  }
  const verifyUts = () => verifyUtsWith(h.uts);

  it.each([
    ['serves past expiry while the issuer fails', JWKS_TTL_MS, { ok: true }],
    ['serves up to just under 24 hours', JWKS_MAX_STALE_MS - 1, { ok: true }],
    [
      'refuses with 503 once the set is 24 hours old',
      JWKS_MAX_STALE_MS,
      { ok: false, status: 503, error: 'temporarily_unavailable', reason: 'jwks_unavailable' },
    ],
  ])('%s', async (_name, after, expected) => {
    await verifyUts();
    h.utsJwks.mode = 'fail';
    advance(after);
    expect(await verifyUts()).toMatchObject(expected);
  });

  it('serves the stale set only while the issuer is unreachable', async () => {
    await verifyUts();
    advance(JWKS_TTL_MS);
    // The issuer answers with a set that no longer holds the key: the stale set is not consulted.
    h.utsJwks.keys = [h.feedSigner.jwk];
    expect(await verifyUts()).toMatchObject({ ok: false, status: 401, reason: 'unknown_kid' });
  });

  it('does not retry the issuer on every request during the backoff', async () => {
    await verifyUts();
    h.utsJwks.mode = 'fail';
    advance(JWKS_TTL_MS);
    await verifyUts();
    await verifyUts();
    expect(h.utsJwks.calls).toBe(2);
    advance(JWKS_RETRY_MS);
    await verifyUts();
    expect(h.utsJwks.calls).toBe(3);
  });

  it('doubles the retry wait per failure while the last good set serves, up to 60 s', async () => {
    await verifyUts();
    h.utsJwks.mode = 'fail';
    advance(JWKS_TTL_MS);
    const waits: number[] = [];
    for (let failures = 1; failures <= 6; failures++) {
      const calls = h.utsJwks.calls;
      expect(await verifyUts()).toMatchObject({ ok: true });
      expect(h.utsJwks.calls).toBe(calls + 1);
      // The wait: no fetch one millisecond before it, the next fetch at it.
      const wait = Math.min(JWKS_MAX_RETRY_MS, JWKS_RETRY_MS * 2 ** (failures - 1));
      advance(wait - 1);
      await verifyUts();
      expect(h.utsJwks.calls).toBe(calls + 1);
      advance(1);
      waits.push(wait);
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it('keeps a 5 s retry wait when no set was ever loaded', async () => {
    h.stsJwks.mode = 'fail';
    for (let i = 0; i < 3; i++) {
      expect(await verify()).toMatchObject({ status: 503, headers: { 'retry-after': '5' } });
      advance(JWKS_RETRY_MS);
    }
    expect(h.stsJwks.calls).toBe(3);
  });

  it('serves the last good set once a refresh of an expired set has not answered in 1 s', async () => {
    await verifyUts();
    advance(JWKS_TTL_MS);
    h.utsJwks.mode = 'hang';
    const token = await sign(h.uts, utsClaims());
    fakeAllTimers();
    let settled = false;
    const pending = h.verifier
      .verify(bearer(token), { issuer: 'uts', scope: SCOPE }, h.ctx)
      .then(result => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(JWKS_STALE_WAIT_MS - 1);
    expect(h.utsJwks.calls).toBe(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: true });
  });

  it('waits the whole fetch timeout for a kid the last good set lacks', async () => {
    await verifyUts();
    advance(JWKS_TTL_MS);
    h.utsJwks.mode = 'hang';
    const token = await sign(await createIssuer(UTS_ISSUER, UTS_TOKEN_KID), utsClaims());
    fakeAllTimers();
    let settled = false;
    const pending = h.verifier
      .verify(bearer(token), { issuer: 'uts', scope: SCOPE }, h.ctx)
      .then(result => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(JWKS_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, status: 503, reason: 'jwks_unavailable' });
  });

  it('never serves an STS set past its 5-minute lifetime', async () => {
    await verify();
    h.stsJwks.mode = 'fail';
    advance(JWKS_TTL_MS - 1);
    expect(await verify()).toMatchObject({ ok: true });
    advance(1);
    expect(await verify()).toMatchObject({ ok: false, status: 503, reason: 'jwks_unavailable' });
  });
});

describe('missing key set', () => {
  it('answers 503 with Retry-After at a cold start, and retries after the backoff', async () => {
    h.stsJwks.mode = 'fail';
    const first = await verify();
    expect(first).toMatchObject({ ok: false, status: 503, reason: 'jwks_unavailable' });
    if (first.ok) throw new Error('expected a failure');
    expect(Number(first.headers['retry-after'])).toBe(JWKS_RETRY_MS / 1000);
    await verify();
    expect(h.stsJwks.calls).toBe(1);
    h.stsJwks.mode = 'ok';
    advance(JWKS_RETRY_MS);
    expect(await verify()).toMatchObject({ ok: true });
    expect(h.stsJwks.calls).toBe(2);
  });

  it('answers 503 once a hung fetch passes its timeout', async () => {
    h.stsJwks.mode = 'hang';
    const pending = verify();
    await vi.waitFor(() => expect(h.stsJwks.calls).toBe(1));
    advance(JWKS_FETCH_TIMEOUT_MS);
    expect(await pending).toMatchObject({ ok: false, status: 503, reason: 'jwks_unavailable' });
  });
});

describe('unknown kid', () => {
  let stranger: Issuer;
  beforeEach(async () => {
    stranger = await createIssuer(STS_ISSUER);
    await verify();
  });

  // Each step: move the clock, then verify with the issuer key ('known') or a kid the set lacks
  // ('stranger'); `fetches` counts key-set fetches after the whole sequence, the cold one included.
  type Step = { after: number; with: 'known' | 'stranger' };
  it.each<[string, Step[], number]>([
    ['an unknown kid refreshes the set once', [{ after: 0, with: 'stranger' }], 2],
    [
      'a second unknown kid within 5 minutes does not refresh',
      [
        { after: 0, with: 'stranger' },
        { after: 60_000, with: 'stranger' },
      ],
      2,
    ],
    [
      'an unknown kid 5 minutes after the last unknown-kid refresh refreshes again',
      [
        { after: 0, with: 'stranger' },
        // Keeps the set fresh through its own 4-minute background refresh (fetch 3).
        { after: JWKS_REFRESH_AFTER_MS, with: 'known' },
        { after: UNKNOWN_KID_REFRESH_INTERVAL_MS - JWKS_REFRESH_AFTER_MS, with: 'stranger' },
      ],
      4,
    ],
  ])('%s', async (_name, steps, fetches) => {
    for (const step of steps) {
      advance(step.after);
      const result = await verifyWith(step.with === 'known' ? h.sts : stranger);
      await drain(h.background);
      expect(result).toMatchObject(
        step.with === 'known' ? { ok: true } : { ok: false, status: 401, reason: 'unknown_kid' }
      );
    }
    expect(h.stsJwks.calls).toBe(fetches);
  });

  it('accepts a key that appears in the set, found by the unknown-kid refresh', async () => {
    h.stsJwks.keys = [h.sts.jwk, stranger.jwk];
    expect(await verifyWith(stranger)).toMatchObject({ ok: true });
    expect(h.stsJwks.calls).toBe(2);
  });

  it('answers 503 when the unknown-kid refresh fails', async () => {
    h.stsJwks.mode = 'fail';
    expect(await verifyWith(stranger)).toMatchObject({
      ok: false,
      status: 503,
      reason: 'jwks_unavailable',
    });
  });

  it('does not refresh twice for an unknown kid at a cold start', async () => {
    const fresh = await harness();
    h = fresh;
    expect(await verifyWith(stranger)).toMatchObject({ ok: false, reason: 'unknown_kid' });
    expect(fresh.stsJwks.calls).toBe(1);
  });

  it('counts a refresh whose request was cancelled against the limit', async () => {
    // Each attack request carries an unknown kid and is cancelled while its refresh is in flight.
    freezeHeartbeats();
    h.stsJwks.mode = 'hang';
    const token = await sign(stranger, stsClaims());
    const results: Promise<VerifyResult>[] = [];
    // 1.5 s apart: past the 1 s abandonment mark, inside the 5 s fetch timeout, for 3 minutes.
    for (let step = 0; step < 120; step++) {
      results.push(h.verifier.verify(bearer(token), { issuer: 'sts', scope: SCOPE }, h.ctx));
      advance(1_500);
    }
    advance(JWKS_FETCH_TIMEOUT_MS);
    const settled = await Promise.all(results);
    // The cold fetch and the one unknown-kid refresh; nothing else in 3 minutes.
    expect(h.stsJwks.calls).toBe(2);
    expect(settled.slice(1).every(r => !r.ok && r.reason === 'unknown_kid')).toBe(true);
  });
});

describe('concurrent refreshes', () => {
  it('merges concurrent cold lookups into one fetch', async () => {
    h = await harness();
    h.stsJwks.gate = gate();
    const pending = Array.from({ length: 10 }, () => verify());
    await vi.waitFor(() => expect(h.stsJwks.calls).toBe(1));
    h.stsJwks.gate.release();
    const results = await Promise.all(pending);
    expect(results.every(result => result.ok)).toBe(true);
    expect(h.stsJwks.calls).toBe(1);
  });
});

describe('the HTTPS key-set source', () => {
  it('fetches <issuer>/.well-known/jwks.json with the signal and parses the body', async () => {
    const seen: string[] = [];
    const source = httpJwksSource('https://sts.test/', async (url, init) => {
      seen.push(url);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ keys: [] });
    });
    expect(await source(AbortSignal.timeout(1000))).toEqual({ keys: [] });
    expect(seen).toEqual(['https://sts.test/.well-known/jwks.json']);
  });

  it.each([
    ['a non-200 answer', () => new Response('no', { status: 503 })],
    ['a body that is not JSON', () => new Response('not json', { status: 200 })],
  ])('rejects %s', async (_name, answer) => {
    const source = httpJwksSource('https://sts.test', async () => answer());
    await expect(source(AbortSignal.timeout(1000))).rejects.toThrow();
  });
});

describe('key-set validation', () => {
  it.each([
    [
      'skips keys that are not Ed25519',
      (k: Record<string, unknown>) => [{ kty: 'EC', crv: 'P-256', kid: 'ec', x: 'a', y: 'b' }, k],
      1,
    ],
    [
      'skips keys marked for another use',
      (k: Record<string, unknown>) => [{ ...k, kid: 'other', use: 'enc' }, k],
      1,
    ],
    ['skips keys without kid', (k: Record<string, unknown>) => [{ ...k, kid: undefined }], 0],
    [
      'never takes a feed-prefixed key as an STS token key',
      (k: Record<string, unknown>) => [{ ...k, kid: `${UTS_FEED_KID}x` }],
      0,
    ],
  ])('%s', async (_name, build, count) => {
    const keys = await importKeySet({ keys: build(h.sts.jwk) }, 'sts');
    expect(keys.tokenKeys.size).toBe(count);
    expect(keys.feedKeys.size).toBe(0);
  });

  it('splits a UTS set into token keys and feed keys by kid prefix, skipping other kids', async () => {
    const token = await createIssuer(UTS_ISSUER, UTS_TOKEN_KID);
    const feed = await createIssuer(UTS_ISSUER, UTS_FEED_KID);
    const unprefixed = await createIssuer(UTS_ISSUER);
    const keys = await importKeySet({ keys: [token.jwk, feed.jwk, unprefixed.jwk] }, 'uts');
    expect([...keys.tokenKeys.keys()]).toEqual([token.kid]);
    expect([...keys.feedKeys.keys()]).toEqual([feed.kid]);
  });

  it.each([
    ['a duplicate kid', (k: Record<string, unknown>) => ({ keys: [k, k] })],
    ['a body without keys', () => ({})],
    ['keys that are not an array', () => ({ keys: {} })],
  ])('refuses %s', async (_name, build) => {
    await expect(importKeySet(build(h.sts.jwk), 'sts')).rejects.toThrow();
  });
});
