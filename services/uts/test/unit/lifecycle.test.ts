import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '../../src/keys/ed25519';
import {
  advance,
  bootstrapState,
  NEXT_KEY_LEAD_MS,
  nextChangeAt,
  publishedKeys,
  removeKey,
  RETIRED_KEY_PUBLISHED_MS,
  ROTATION_INTERVAL_MS,
  type SignerState,
} from '../../src/keys/lifecycle';

const SIGNER = 3;
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 25);
const generate = () => generateSigningKey(SIGNER);

const kids = (state: SignerState) => publishedKeys(state).map(key => key.kid);

describe('key lifecycle constants', () => {
  it('match design 5.7 and the 1-hour longest token', () => {
    expect(ROTATION_INTERVAL_MS).toBe(30 * DAY);
    expect(NEXT_KEY_LEAD_MS).toBe(7 * DAY);
    expect(RETIRED_KEY_PUBLISHED_MS).toBe(70 * 60 * 1000);
  });
});

describe('bootstrap', () => {
  it('publishes a current and a next key, the next one 30 days before it signs', async () => {
    const state = await bootstrapState(SIGNER, T0, generate);
    expect(state.signer).toBe(SIGNER);
    expect(state.current.activatedAt).toBe(T0);
    expect(state.next?.publishedAt).toBe(T0);
    expect(state.next?.activatesAt).toBe(T0 + 30 * DAY);
    expect(state.retired).toEqual([]);
    expect(kids(state)).toEqual([state.current.kid, state.next?.kid]);
    expect(nextChangeAt(state)).toBe(T0 + 30 * DAY);
  });
});

describe('advance', () => {
  it('returns the same state when nothing is due', async () => {
    const state = await bootstrapState(SIGNER, T0, generate);
    expect(await advance(state, T0 + 30 * DAY - 1, generate)).toBe(state);
  });

  it('rotates at 30 days, keeps the retired key 70 minutes, and publishes the next key 7 days ahead', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const firstKid = start.current.kid;
    const secondKid = start.next?.kid;

    const rotated = await advance(start, T0 + 30 * DAY, generate);
    expect(rotated.current.kid).toBe(secondKid);
    expect(rotated.current.activatedAt).toBe(T0 + 30 * DAY);
    expect(rotated.next).toBeNull();
    expect(rotated.retired).toEqual([
      {
        kid: firstKid,
        publicJwk: start.current.publicJwk,
        retiredAt: T0 + 30 * DAY,
        publishedUntil: T0 + 30 * DAY + 70 * 60 * 1000,
      },
    ]);
    expect(nextChangeAt(rotated)).toBe(T0 + 30 * DAY + 70 * 60 * 1000);

    const stillPublished = await advance(rotated, T0 + 30 * DAY + 70 * 60 * 1000 - 1, generate);
    expect(kids(stillPublished)).toContain(firstKid);
    const dropped = await advance(stillPublished, T0 + 30 * DAY + 70 * 60 * 1000, generate);
    expect(kids(dropped)).toEqual([secondKid]);
    expect(nextChangeAt(dropped)).toBe(T0 + 53 * DAY);

    const withNext = await advance(dropped, T0 + 53 * DAY, generate);
    expect(withNext.next?.publishedAt).toBe(T0 + 53 * DAY);
    expect(withNext.next?.activatesAt).toBe(T0 + 60 * DAY);
    expect(kids(withNext)).toEqual([secondKid, withNext.next?.kid]);
  });

  it('never activates a key less than 7 days after a late alarm published it', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const rotated = await advance(start, T0 + 30 * DAY, generate);
    const late = await advance(rotated, T0 + 65 * DAY, generate);
    expect(late.current.kid).toBe(rotated.current.kid);
    expect(late.next?.activatesAt).toBe(T0 + 72 * DAY);
    expect(late.retired).toEqual([]);
  });

  it('keeps every invariant over a year of hourly alarms', async () => {
    let state = await bootstrapState(SIGNER, T0, generate);
    const publishedAt = new Map<string, number>([
      [state.current.kid, T0],
      [state.next?.kid ?? '', T0],
    ]);
    const signedUntil = new Map<string, number>();
    let rotations = 0;
    for (let now = T0; now <= T0 + 365 * DAY; now += 60 * 60 * 1000) {
      const before = state;
      state = await advance(state, now, generate);
      if (state.next !== null && !publishedAt.has(state.next.kid))
        publishedAt.set(state.next.kid, now);
      if (state.current.kid !== before.current.kid) {
        rotations += 1;
        signedUntil.set(before.current.kid, now);
        expect(now - (publishedAt.get(state.current.kid) ?? now)).toBeGreaterThanOrEqual(
          NEXT_KEY_LEAD_MS
        );
      }
      expect(state.current.activatedAt + ROTATION_INTERVAL_MS).toBeGreaterThan(
        now - 60 * 60 * 1000
      );
      for (const [kid, until] of signedUntil) {
        const published = kids(state).includes(kid);
        expect(published).toBe(now < until + RETIRED_KEY_PUBLISHED_MS);
      }
    }
    expect(rotations).toBe(12);
  });
});

describe('removeKey', () => {
  it('replaces a removed current key with the published next key at once', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const removed = await removeKey(start, start.current.kid, T0 + DAY, generate);
    if (removed.status !== 'removed') throw new Error('expected removal');
    expect(removed.state.current.kid).toBe(start.next?.kid);
    expect(removed.state.current.activatedAt).toBe(T0 + DAY);
    expect(kids(removed.state)).not.toContain(start.current.kid);
    expect(removed.removal).toEqual({
      kid: start.current.kid,
      signer: SIGNER,
      removedAt: T0 + DAY,
      revokeUntil: T0 + DAY + RETIRED_KEY_PUBLISHED_MS,
    });
  });

  it('signs with a fresh key when the removed current key has no next key', async () => {
    const rotated = await advance(
      await bootstrapState(SIGNER, T0, generate),
      T0 + 30 * DAY,
      generate
    );
    const removed = await removeKey(rotated, rotated.current.kid, T0 + 31 * DAY, generate);
    if (removed.status !== 'removed') throw new Error('expected removal');
    expect(removed.state.current.kid).not.toBe(rotated.current.kid);
    expect(kids(removed.state)).not.toContain(rotated.current.kid);
  });

  it('drops a removed next key and generates the replacement with a full lead', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const removed = await removeKey(start, start.next?.kid ?? '', T0 + 25 * DAY, generate);
    if (removed.status !== 'removed') throw new Error('expected removal');
    expect(removed.state.next?.kid).not.toBe(start.next?.kid);
    expect(removed.state.next?.activatesAt).toBe(T0 + 32 * DAY);
  });

  it('drops a removed retired key from the published set', async () => {
    const rotated = await advance(
      await bootstrapState(SIGNER, T0, generate),
      T0 + 30 * DAY,
      generate
    );
    const retiredKid = rotated.retired[0]?.kid ?? '';
    const removed = await removeKey(rotated, retiredKid, T0 + 30 * DAY + 1, generate);
    if (removed.status !== 'removed') throw new Error('expected removal');
    expect(kids(removed.state)).toEqual([rotated.current.kid]);
  });

  it('reports an unknown kid without a change', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    expect(await removeKey(start, 'uts-token-03-unknown', T0, generate)).toEqual({
      status: 'unknown_kid',
    });
  });
});
