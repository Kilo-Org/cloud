import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '../../src/keys/ed25519';
import {
  advance,
  bootstrapState,
  NEXT_KEY_MIN_LEAD_MS,
  nextChangeAt,
  publishedKeys,
  removeKey,
  RETIRED_KEY_PUBLISHED_MS,
  ROTATION_INTERVAL_MS,
  type SignerState,
} from '../../src/keys/lifecycle';

const SIGNER = 3;
const DAY = 24 * 60 * 60 * 1000;
const RETIRED = 70 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 25);
const generate = () => generateSigningKey(SIGNER);

const kids = (state: SignerState) => publishedKeys(state).map(key => key.kid);

async function removed(state: SignerState, kid: string, now: number) {
  const result = await removeKey(state, kid, now, generate);
  if (result.status !== 'removed') throw new Error('expected removal');
  return result;
}

describe('key lifecycle constants', () => {
  it('match design 5.7 and the 1-hour longest token', () => {
    expect(ROTATION_INTERVAL_MS).toBe(30 * DAY);
    expect(NEXT_KEY_MIN_LEAD_MS).toBe(7 * DAY);
    expect(RETIRED_KEY_PUBLISHED_MS).toBe(RETIRED);
  });
});

describe('bootstrap', () => {
  it('publishes a current and a next key, the next one 30 days before it signs', async () => {
    const state = await bootstrapState(SIGNER, T0, generate);
    expect(state.signer).toBe(SIGNER);
    expect(state.current.activatedAt).toBe(T0);
    expect(state.next.publishedAt).toBe(T0);
    expect(state.next.activatesAt).toBe(T0 + 30 * DAY);
    expect(state.retired).toEqual([]);
    expect(state.removed).toEqual([]);
    expect(kids(state)).toEqual([state.current.kid, state.next.kid]);
    expect(nextChangeAt(state)).toBe(T0 + 30 * DAY);
  });
});

describe('advance', () => {
  it('returns the same state and no event when nothing is due', async () => {
    const state = await bootstrapState(SIGNER, T0, generate);
    const result = await advance(state, T0 + 30 * DAY - 1, generate);
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });

  it('rotates at 30 days, publishes the new next key at once, and keeps the retired key 70 minutes', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const firstKid = start.current.kid;
    const secondKid = start.next.kid;

    const { state: rotated, events } = await advance(start, T0 + 30 * DAY, generate);
    expect(rotated.current.kid).toBe(secondKid);
    expect(rotated.current.activatedAt).toBe(T0 + 30 * DAY);
    expect(rotated.next.publishedAt).toBe(T0 + 30 * DAY);
    expect(rotated.next.activatesAt).toBe(T0 + 60 * DAY);
    expect(rotated.retired).toEqual([
      {
        kid: firstKid,
        publicJwk: start.current.publicJwk,
        retiredAt: T0 + 30 * DAY,
        publishedUntil: T0 + 30 * DAY + RETIRED,
      },
    ]);
    expect(kids(rotated)).toEqual([secondKid, rotated.next.kid, firstKid]);
    expect(events).toEqual([
      {
        type: 'rotated',
        signer: SIGNER,
        at: T0 + 30 * DAY,
        kid: secondKid,
        retiredKid: firstKid,
        nextKid: rotated.next.kid,
      },
    ]);
    expect(nextChangeAt(rotated)).toBe(T0 + 30 * DAY + RETIRED);

    const stillPublished = await advance(rotated, T0 + 30 * DAY + RETIRED - 1, generate);
    expect(stillPublished.state).toBe(rotated);
    const dropped = await advance(rotated, T0 + 30 * DAY + RETIRED, generate);
    expect(kids(dropped.state)).toEqual([secondKid, rotated.next.kid]);
    expect(dropped.events).toEqual([]);
    expect(nextChangeAt(dropped.state)).toBe(T0 + 60 * DAY);
  });

  it('counts the next 30 days from a late rotation', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const { state } = await advance(start, T0 + 35 * DAY, generate);
    expect(state.current.activatedAt).toBe(T0 + 35 * DAY);
    expect(state.next.activatesAt).toBe(T0 + 65 * DAY);
  });

  it('keeps every invariant over a year of hourly alarms', async () => {
    let state = await bootstrapState(SIGNER, T0, generate);
    const publishedAt = new Map<string, number>([
      [state.current.kid, T0],
      [state.next.kid, T0],
    ]);
    const signedUntil = new Map<string, number>();
    let rotations = 0;
    for (let now = T0; now <= T0 + 365 * DAY; now += 60 * 60 * 1000) {
      const before = state;
      state = (await advance(state, now, generate)).state;
      if (!publishedAt.has(state.next.kid)) publishedAt.set(state.next.kid, now);
      if (state.current.kid !== before.current.kid) {
        rotations += 1;
        signedUntil.set(before.current.kid, now);
        expect(now - (publishedAt.get(state.current.kid) ?? now)).toBeGreaterThanOrEqual(
          NEXT_KEY_MIN_LEAD_MS
        );
      }
      // Every state publishes the key that signs next.
      expect(kids(state)).toContain(state.next.kid);
      expect(state.current.activatedAt + ROTATION_INTERVAL_MS).toBeGreaterThan(
        now - 60 * 60 * 1000
      );
      for (const [kid, until] of signedUntil) {
        expect(kids(state).includes(kid)).toBe(now < until + RETIRED_KEY_PUBLISHED_MS);
      }
    }
    expect(rotations).toBe(12);
  });
});

describe('removeKey', () => {
  it('replaces a removed current key with the published next key and publishes a new next key', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const result = await removed(start, start.current.kid, T0 + DAY);
    expect(result.state.current.kid).toBe(start.next.kid);
    expect(result.state.current.activatedAt).toBe(T0 + DAY);
    expect(result.state.next.kid).not.toBe(start.next.kid);
    expect(result.state.next.publishedAt).toBe(T0 + DAY);
    expect(result.state.next.activatesAt).toBe(T0 + 31 * DAY);
    expect(kids(result.state)).toEqual([start.next.kid, result.state.next.kid]);
    expect(result.removal).toEqual({
      kid: start.current.kid,
      signer: SIGNER,
      removedAt: T0 + DAY,
      revokeUntil: T0 + DAY + RETIRED_KEY_PUBLISHED_MS,
    });
    expect(result.state.removed).toEqual([result.removal]);
    expect(result.event).toEqual({
      type: 'removed',
      signer: SIGNER,
      at: T0 + DAY,
      kid: start.current.kid,
      role: 'current',
      currentKid: start.next.kid,
      nextKid: result.state.next.kid,
    });
  });

  it('always has a published key to switch to, at any day of the cycle', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const { state: rotated } = await advance(start, T0 + 30 * DAY, generate);
    for (const day of [31, 45, 59]) {
      const result = await removed(rotated, rotated.current.kid, T0 + day * DAY);
      expect(kids(rotated)).toContain(result.state.current.kid);
    }
  });

  it('replaces a removed next key with one published at least 7 days before it signs', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const late = await removed(start, start.next.kid, T0 + 25 * DAY);
    expect(late.state.next.kid).not.toBe(start.next.kid);
    expect(late.state.next.activatesAt).toBe(T0 + 32 * DAY);
    const early = await removed(start, start.next.kid, T0 + 2 * DAY);
    expect(early.state.next.activatesAt).toBe(T0 + 30 * DAY);
    expect(early.event).toMatchObject({ role: 'next', currentKid: start.current.kid });
  });

  it('after a storage exposure, removing next then current signs under a key created after it', async () => {
    const exposed = await bootstrapState(SIGNER, T0, generate);
    const first = await removed(exposed, exposed.next.kid, T0 + DAY);
    const second = await removed(first.state, exposed.current.kid, T0 + DAY + 1);
    expect(second.state.current.kid).toBe(first.state.next.kid);
    expect(kids(second.state)).not.toContain(exposed.current.kid);
    expect(kids(second.state)).not.toContain(exposed.next.kid);
  });

  it('drops a removed retired key from the published set', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const { state: rotated } = await advance(start, T0 + 30 * DAY, generate);
    const retiredKid = rotated.retired[0]?.kid ?? '';
    const result = await removed(rotated, retiredKid, T0 + 30 * DAY + 1);
    expect(kids(result.state)).toEqual([rotated.current.kid, rotated.next.kid]);
    expect(result.event).toMatchObject({ role: 'retired', kid: retiredKid });
  });

  it('reports an unknown kid without a change', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    expect(await removeKey(start, 'uts-token-03-unknown', T0, generate)).toEqual({
      status: 'unknown_kid',
    });
  });

  it('answers the stored receipt for a kid removed before, and changes nothing', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const first = await removed(start, start.current.kid, T0 + DAY);
    expect(await removeKey(first.state, start.current.kid, T0 + DAY + 1000, generate)).toEqual({
      status: 'already_removed',
      removal: first.removal,
    });
  });

  it('keeps a removal receipt until its revokeUntil, and wakes then to drop it', async () => {
    const start = await bootstrapState(SIGNER, T0, generate);
    const { state, removal } = await removed(start, start.next.kid, T0 + DAY);
    expect(nextChangeAt(state)).toBe(removal.revokeUntil);
    const before = await advance(state, removal.revokeUntil - 1, generate);
    expect(before.state).toBe(state);
    const after = await advance(state, removal.revokeUntil, generate);
    expect(after.state.removed).toEqual([]);
    expect(after.events).toEqual([]);
    expect(await removeKey(after.state, start.next.kid, removal.revokeUntil, generate)).toEqual({
      status: 'unknown_kid',
    });
  });
});
