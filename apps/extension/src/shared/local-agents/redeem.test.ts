/* eslint-disable eslint/id-length -- `v` is the wire field name */
/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { describe, expect, it } from 'vitest';
import { pairingKeyUrl } from './pairing';
import { redeemPairingKey } from './redeem';
import type { LocalAgentFetch } from './redeem';

const HUB_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const WS = 'ws://127.0.0.1:47917/__kilo_browser';
const TOKEN = 'EBESExQVFhcYGRobHB0eHw';

const fetchReturning = (status: number, body: Record<string, unknown> | null) => {
  const calls: { body: string; method: string; url: string }[] = [];
  const fetchImpl: LocalAgentFetch = (url, init) => {
    calls.push({ body: init.body, method: init.method, url });

    return Promise.resolve({ json: () => Promise.resolve(body), status });
  };

  return { calls, fetchImpl };
};

const redeem = (fetchImpl: LocalAgentFetch) =>
  redeemPairingKey({ fetchImpl, hubId: HUB_ID, token: TOKEN, ws: WS });

describe('pairing key redemption', () => {
  it('builds the redeem URL from the loopback socket origin', () => {
    expect(pairingKeyUrl(WS)).toBe('http://127.0.0.1:47917/__kilo_browser_pair/key');
    expect(pairingKeyUrl('ws://hub.kilo.ai/__kilo_browser')).toBeNull();
  });

  it('returns the stored endpoint on 200', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { key: KEY, v: 1, ws: WS });

    await expect(redeem(fetchImpl)).resolves.toStrictEqual({
      endpoint: { hubId: HUB_ID, key: KEY, ws: WS },
      ok: true,
    });
    expect(calls).toStrictEqual([
      {
        body: JSON.stringify({ t: TOKEN }),
        method: 'POST',
        url: 'http://127.0.0.1:47917/__kilo_browser_pair/key',
      },
    ]);
  });

  it('maps 403 to a refused origin and 404 to an expired token', async () => {
    await expect(redeem(fetchReturning(403, null).fetchImpl)).resolves.toStrictEqual({
      ok: false,
      reason: 'not_allowed',
    });
    await expect(redeem(fetchReturning(404, null).fetchImpl)).resolves.toStrictEqual({
      ok: false,
      reason: 'expired',
    });
    await expect(redeem(fetchReturning(500, null).fetchImpl)).resolves.toStrictEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a non-loopback socket in the response', async () => {
    await expect(
      redeem(
        fetchReturning(200, { key: KEY, v: 1, ws: 'ws://hub.kilo.ai/__kilo_browser' }).fetchImpl
      )
    ).resolves.toStrictEqual({ ok: false, reason: 'invalid' });
    await expect(
      redeem(
        fetchReturning(200, { key: KEY, v: 1, ws: 'ws://10.0.0.5:47917/__kilo_browser' }).fetchImpl
      )
    ).resolves.toStrictEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a short key, a bad version, and malformed bodies', async () => {
    await expect(
      redeem(fetchReturning(200, { key: 'short', v: 1, ws: WS }).fetchImpl)
    ).resolves.toStrictEqual({
      ok: false,
      reason: 'invalid',
    });
    await expect(
      redeem(fetchReturning(200, { key: KEY, v: 2, ws: WS }).fetchImpl)
    ).resolves.toStrictEqual({
      ok: false,
      reason: 'invalid',
    });
    await expect(redeem(fetchReturning(200, null).fetchImpl)).resolves.toStrictEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('treats a transport failure as invalid', async () => {
    const failing: LocalAgentFetch = () => Promise.reject(new Error('offline'));

    await expect(redeem(failing)).resolves.toStrictEqual({ ok: false, reason: 'invalid' });
  });
});
