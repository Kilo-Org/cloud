import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_RETRY_MS,
  FEED_REFRESH_AFTER_MS,
  JWKS_REFRESH_AFTER_MS,
  type VerifyResult,
} from '../src/index';
import {
  SCOPE,
  UTS_FEED_KID,
  UTS_ISSUER,
  bearer,
  createIssuer,
  drain,
  freezeHeartbeats,
  gate,
  harness,
  sign,
  stsClaims,
  utsClaims,
  type Harness,
} from './helpers';

// Design 7 cold start: one UTS bootstrap call fills the UTS key set and the feed; `warm` starts the
// cold fetches in parallel under the caller's waitUntil.

let h: Harness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
  h = await harness({ bootstrap: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

async function verifyUts(): Promise<VerifyResult> {
  return await h.verifier.verify(
    bearer(await sign(h.uts, utsClaims())),
    { issuer: 'uts', scope: SCOPE },
    h.ctx
  );
}

async function verifySts(): Promise<VerifyResult> {
  return await h.verifier.verify(
    bearer(await sign(h.sts, stsClaims())),
    { issuer: 'sts', scope: SCOPE },
    h.ctx
  );
}

describe('the UTS bootstrap', () => {
  it('loads the UTS key set and the feed in one call at a cold start', async () => {
    expect(await verifyUts()).toMatchObject({ ok: true });
    expect([h.bootstrap.calls, h.utsJwks.calls, h.feed.calls]).toEqual([1, 0, 0]);
  });

  it('merges concurrent cold requests into one bootstrap call', async () => {
    h.bootstrap.gate = gate();
    const pending = Array.from({ length: 10 }, () => verifyUts());
    await vi.waitFor(() => expect(h.bootstrap.calls).toBe(1));
    h.bootstrap.gate.release();
    const results = await Promise.all(pending);
    expect(results.every(result => result.ok)).toBe(true);
    expect(h.bootstrap.calls).toBe(1);
  });

  it('answers 503 while the bootstrap fails, without the separate sources, and retries after 5 s', async () => {
    h.bootstrap.mode = 'fail';
    const refused = await verifyUts();
    expect(refused).toMatchObject({
      ok: false,
      status: 503,
      reason: 'bootstrap_unavailable',
      headers: { 'retry-after': String(BOOTSTRAP_RETRY_MS / 1000) },
    });
    await verifyUts();
    expect([h.bootstrap.calls, h.utsJwks.calls, h.feed.calls]).toEqual([1, 0, 0]);
    h.bootstrap.mode = 'ok';
    advance(BOOTSTRAP_RETRY_MS);
    expect(await verifyUts()).toMatchObject({ ok: true });
    expect(h.bootstrap.calls).toBe(2);
  });

  it('applies nothing from an answer whose head does not verify under its own key set', async () => {
    const signer = h.feed.signer;
    h.feed.signer = await createIssuer(UTS_ISSUER, UTS_FEED_KID);
    expect(await verifyUts()).toMatchObject({ status: 503, reason: 'bootstrap_unavailable' });
    h.feed.signer = signer;
    advance(BOOTSTRAP_RETRY_MS);
    expect(await verifyUts()).toMatchObject({ ok: true });
    expect([h.bootstrap.calls, h.utsJwks.calls]).toEqual([2, 0]);
  });

  it('leaves warm refreshes to the separate sources', async () => {
    await verifyUts();
    advance(FEED_REFRESH_AFTER_MS);
    await verifyUts();
    await drain(h.background);
    expect([h.bootstrap.calls, h.feed.calls]).toEqual([1, 1]);
    advance(JWKS_REFRESH_AFTER_MS);
    await verifyUts();
    await drain(h.background);
    expect([h.bootstrap.calls, h.utsJwks.calls]).toEqual([1, 1]);
  });

  it('counts a bootstrap call whose request was cancelled as a failed one', async () => {
    freezeHeartbeats();
    h.bootstrap.mode = 'hang';
    const token = await sign(h.uts, utsClaims());
    const route = { issuer: 'uts', scope: SCOPE } as const;
    const first = h.verifier.verify(bearer(token), route, h.ctx);
    advance(1_500);
    expect(await h.verifier.verify(bearer(token), route, h.ctx)).toMatchObject({
      status: 503,
      reason: 'bootstrap_unavailable',
    });
    advance(1_500);
    expect(await h.verifier.verify(bearer(token), route, h.ctx)).toMatchObject({ status: 503 });
    expect(h.bootstrap.calls).toBe(1);
    expect(await first).toMatchObject({ status: 503 });
  });
});

describe('warm', () => {
  it('starts the UTS bootstrap and the STS key set in parallel, without waiting', async () => {
    h.bootstrap.gate = gate();
    h.stsJwks.gate = gate();
    h.verifier.warm(h.ctx);
    await vi.waitFor(() => expect([h.bootstrap.calls, h.stsJwks.calls]).toEqual([1, 1]));
    expect(h.background).toHaveLength(2);
    h.bootstrap.gate.release();
    h.stsJwks.gate.release();
    expect(await verifyUts()).toMatchObject({ ok: true });
    expect(await verifySts()).toMatchObject({ ok: true });
    expect([h.bootstrap.calls, h.stsJwks.calls, h.utsJwks.calls, h.feed.calls]).toEqual([
      1, 1, 0, 0,
    ]);
  });

  it('lets a request join the fetches warm started', async () => {
    h.bootstrap.gate = gate();
    h.verifier.warm(h.ctx);
    const pending = verifyUts();
    await vi.waitFor(() => expect(h.bootstrap.calls).toBe(1));
    h.bootstrap.gate.release();
    expect(await pending).toMatchObject({ ok: true });
    expect(h.bootstrap.calls).toBe(1);
  });

  it('starts the UTS key set when no bootstrap is configured', async () => {
    h = await harness();
    h.verifier.warm(h.ctx);
    await drain(h.background);
    expect([h.utsJwks.calls, h.stsJwks.calls, h.feed.calls]).toEqual([1, 1, 0]);
  });

  it('fetches nothing once the caches hold data', async () => {
    await verifyUts();
    await verifySts();
    const handedOff = h.background.length;
    h.verifier.warm(h.ctx);
    expect(h.background).toHaveLength(handedOff);
    expect([h.bootstrap.calls, h.stsJwks.calls]).toEqual([1, 1]);
  });
});
