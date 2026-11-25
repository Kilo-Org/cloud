import { describe, expect, it } from 'vitest';
import {
  TOKEN_KEY_CURRENT_MS,
  TOKEN_KEY_PUBLISH_AHEAD_MS,
  TOKEN_KEY_RETIRED_GRACE_MS,
} from '../../src/constants';
import {
  advanceKeyRing,
  keyRingDueAt,
  publishedKeys,
  recordSignedExp,
  type GeneratedKey,
  type KeyRing,
} from '../../src/tokens/key-ring';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

/** Deterministic keys: `kid-1`, `kid-2`, ... padded to a thumbprint's 43 characters. */
function keyFactory(): () => Promise<GeneratedKey> {
  let made = 0;
  return async () => {
    made += 1;
    const kid = `kid-${made}`.padEnd(43, '_');
    return { kid, pkcs8: `pkcs8-${made}`, x: `x-${made}`.padEnd(43, '_') };
  };
}

const kid = (index: number) => `kid-${index}`.padEnd(43, '_');

function states(ring: KeyRing): Record<string, string> {
  return Object.fromEntries(ring.keys.map(key => [key.kid, key.state]));
}

async function ringAt(
  ring: KeyRing,
  now: number,
  generate: () => Promise<GeneratedKey>,
  revokedKids: string[] = []
) {
  return await advanceKeyRing(ring, { now, revokedKids, generate });
}

describe('token key ring rotation', () => {
  it('publishes the next key 7 days ahead, switches at 30 days, removes the retired key after its last token', async () => {
    const generate = keyFactory();
    const first = await ringAt({ keys: [] }, START, generate);
    expect(first.changes).toEqual([{ change: 'created', kid: kid(1) }]);
    expect(states(first.ring)).toEqual({ [kid(1)]: 'current' });

    // Nothing is due before day 23, and the ring says so.
    const publishAt = START + TOKEN_KEY_CURRENT_MS - TOKEN_KEY_PUBLISH_AHEAD_MS;
    expect(publishAt).toBe(START + 23 * DAY_MS);
    expect(keyRingDueAt(first.ring, [], START)).toBe(publishAt);
    const early = await ringAt(first.ring, publishAt - 1, generate);
    expect(early.changes).toEqual([]);

    // Day 23: the next key is generated and published, still not signing.
    const published = await ringAt(first.ring, publishAt, generate);
    expect(published.changes).toEqual([
      { change: 'published', kid: kid(2), activatesAt: START + 30 * DAY_MS },
    ]);
    expect(states(published.ring)).toEqual({ [kid(1)]: 'current', [kid(2)]: 'next' });
    expect(publishedKeys(published.ring).map(key => key.kid)).toEqual([kid(1), kid(2)]);
    expect(keyRingDueAt(published.ring, [], publishAt)).toBe(START + 30 * DAY_MS);

    // The current key signs a token expiring at day 30 + 5 minutes, just before the switch.
    const switchAt = START + 30 * DAY_MS;
    const lastExp = Math.floor((switchAt - 1_000) / 1000) + 300;
    expect(recordSignedExp(published.ring, kid(1), lastExp)).toBe(true);
    expect(recordSignedExp(published.ring, kid(1), lastExp - 30)).toBe(false);

    // Day 30: the next key signs, the old key is retired but stays published.
    const switched = await ringAt(published.ring, switchAt, generate);
    expect(switched.changes).toEqual([{ change: 'activated', kid: kid(2), retiredKid: kid(1) }]);
    expect(states(switched.ring)).toEqual({ [kid(1)]: 'retired', [kid(2)]: 'current' });
    expect(publishedKeys(switched.ring).map(key => key.kid)).toEqual([kid(1), kid(2)]);

    // It leaves the key set 10 minutes after its last token expires (rounded up to the minute).
    const roundedExp = Math.ceil(lastExp / 60) * 60;
    const removeAt = roundedExp * 1000 + TOKEN_KEY_RETIRED_GRACE_MS;
    expect(keyRingDueAt(switched.ring, [], switchAt)).toBe(removeAt);
    const kept = await ringAt(switched.ring, removeAt - 1, generate);
    expect(states(kept.ring)).toEqual({ [kid(1)]: 'retired', [kid(2)]: 'current' });
    const removed = await ringAt(switched.ring, removeAt, generate);
    expect(removed.changes).toEqual([{ change: 'removed', kid: kid(1), lastTokenExp: roundedExp }]);
    expect(publishedKeys(removed.ring).map(key => key.kid)).toEqual([kid(2)]);

    // The new current key follows the same schedule from its own activation.
    expect(keyRingDueAt(removed.ring, [], removeAt)).toBe(switchAt + 23 * DAY_MS);
  });

  it('changes nothing when run twice at the same time', async () => {
    const generate = keyFactory();
    const first = await ringAt({ keys: [] }, START, generate);
    const published = await ringAt(first.ring, START + 23 * DAY_MS, generate);
    const again = await ringAt(published.ring, START + 23 * DAY_MS, generate);
    expect(again.changes).toEqual([]);
    expect(again.revocations).toEqual([]);
    expect(again.ring).toEqual(published.ring);
  });

  it('still publishes a full 7 days ahead after an object slept through the dates', async () => {
    const generate = keyFactory();
    const first = await ringAt({ keys: [] }, START, generate);
    const late = START + 40 * DAY_MS;
    const woke = await ringAt(first.ring, late, generate);
    expect(woke.changes).toEqual([
      { change: 'published', kid: kid(2), activatesAt: late + TOKEN_KEY_PUBLISH_AHEAD_MS },
    ]);
    expect(states(woke.ring)).toEqual({ [kid(1)]: 'current', [kid(2)]: 'next' });
  });

  it('removes a retired key that signed nothing 10 minutes after it retired', async () => {
    const generate = keyFactory();
    const first = await ringAt({ keys: [] }, START, generate);
    const published = await ringAt(first.ring, START + 23 * DAY_MS, generate);
    const switched = await ringAt(published.ring, START + 30 * DAY_MS, generate);
    expect(keyRingDueAt(switched.ring, [], START + 30 * DAY_MS)).toBe(
      START + 30 * DAY_MS + TOKEN_KEY_RETIRED_GRACE_MS
    );
  });
});

describe('emergency key removal', () => {
  it('drops the current key at once, never signs with it again, and promotes a fresh key', async () => {
    const generate = keyFactory();
    const first = await ringAt({ keys: [] }, START, generate);
    const published = await ringAt(first.ring, START + 23 * DAY_MS, generate);
    const now = START + 24 * DAY_MS;
    expect(keyRingDueAt(published.ring, [kid(1)], now)).toBe(now);

    const revoked = await ringAt(published.ring, now, generate, [kid(1)]);
    expect(revoked.revocations).toEqual([
      { kid: kid(1), state: 'current', replacementKid: kid(3) },
    ]);
    expect(revoked.changes).toEqual([]);
    expect(states(revoked.ring)).toEqual({ [kid(2)]: 'next', [kid(3)]: 'current' });
    expect(publishedKeys(revoked.ring).map(key => key.kid)).not.toContain(kid(1));
    // The fresh key signs from now; the published next key keeps its date.
    expect(revoked.ring.keys.find(key => key.kid === kid(3))?.activatesAt).toBe(now);
    expect(keyRingDueAt(revoked.ring, [kid(1)], now)).toBe(START + 30 * DAY_MS);

    // Still listed later: nothing more to do, and the kid never comes back.
    const later = await ringAt(revoked.ring, now + DAY_MS, generate, [kid(1)]);
    expect(later.revocations).toEqual([]);
    expect(later.ring.keys.map(key => key.kid)).not.toContain(kid(1));
  });

  it('drops a next or retired key without touching the current one', async () => {
    const generate = keyFactory();
    const first = await ringAt({ keys: [] }, START, generate);
    const published = await ringAt(first.ring, START + 23 * DAY_MS, generate);
    const nextRevoked = await ringAt(published.ring, START + 23 * DAY_MS + 1, generate, [kid(2)]);
    expect(nextRevoked.revocations).toEqual([{ kid: kid(2), state: 'next', replacementKid: null }]);
    // Inside the publish window, a replacement next key is published at once, 7 days ahead.
    expect(nextRevoked.changes).toEqual([
      {
        change: 'published',
        kid: kid(3),
        activatesAt: START + 23 * DAY_MS + 1 + TOKEN_KEY_PUBLISH_AHEAD_MS,
      },
    ]);
    expect(states(nextRevoked.ring)).toEqual({ [kid(1)]: 'current', [kid(3)]: 'next' });

    const switched = await ringAt(published.ring, START + 30 * DAY_MS, generate);
    const retiredRevoked = await ringAt(switched.ring, START + 30 * DAY_MS + 1, generate, [kid(1)]);
    expect(retiredRevoked.revocations).toEqual([
      { kid: kid(1), state: 'retired', replacementKid: null },
    ]);
    expect(states(retiredRevoked.ring)).toEqual({ [kid(2)]: 'current' });
  });
});
