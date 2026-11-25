import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEED_FETCH_TIMEOUT_MS,
  FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS,
  FEED_MAX_FETCHED_HEAD_AGE_MS,
  FEED_REFRESH_AFTER_MS,
  FEED_RETRY_MS,
  FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS,
  FEED_WAIT_AFTER_MS,
  type VerifyResult,
} from '../src/index';
import { maxHeadAgeForLifetime } from '../src/revocation';
import {
  SCOPE,
  bearer,
  drain,
  emptyList,
  gate,
  harness,
  nowSeconds,
  sign,
  utsClaims,
  type Harness,
} from './helpers';

// Design 5.6 and 7: request-driven revalidation of the revocation feed and its head-age limits.

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

  it('waits for the refresh once the signed head is over 30 s old', async () => {
    await verify();
    advance(FEED_WAIT_AFTER_MS + 1);
    h.feed.gate = gate();
    let settled = false;
    const pending = verify().then(result => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(h.feed.calls).toBe(2));
    expect(settled).toBe(false);
    h.feed.gate.release();
    expect(await pending).toMatchObject({ ok: true });
  });

  it('fetches the list only when the head names a new hash, and applies it', async () => {
    await verify();
    advance(FEED_REFRESH_AFTER_MS);
    await verify();
    await drain(h.background);
    expect(h.feed.listsSent).toBe(1);
    expect(h.feed.heldOnLastCall?.listHash).toBe('hash-1');

    h.feed.list = { ...emptyList(), revokedSids: new Set(['grant-1']) };
    h.feed.listHash = 'hash-2';
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
  });
});

describe('fetched heads that do not count', () => {
  it('counts a fetched head over 30 s old as a failed fetch', async () => {
    h.feed.headAgeMs = FEED_MAX_FETCHED_HEAD_AGE_MS + 1;
    expect(await verify()).toMatchObject(unavailable);
  });

  it('refuses a head older than the one it holds', async () => {
    const firstHeadAt = Date.now();
    await verify();
    advance(FEED_REFRESH_AFTER_MS);
    h.feed.headIssuedAt = firstHeadAt - 1;
    h.feed.list = { ...emptyList(), revokedSids: new Set(['grant-1']) };
    h.feed.listHash = 'hash-replayed';
    await verify();
    await drain(h.background);
    // The replayed head was dropped, so its list never applied.
    expect(await verify()).toMatchObject({ ok: true });
  });

  it('answers 503 once a hung first fetch passes its timeout', async () => {
    h.feed.mode = 'hang';
    const pending = verify();
    await vi.waitFor(() => expect(h.feed.calls).toBe(1));
    advance(FEED_FETCH_TIMEOUT_MS);
    expect(await pending).toMatchObject(unavailable);
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

  it('chooses the limit by token lifetime', () => {
    expect(maxHeadAgeForLifetime(600)).toBe(FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS);
    expect(maxHeadAgeForLifetime(601)).toBe(FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS);
  });
});
