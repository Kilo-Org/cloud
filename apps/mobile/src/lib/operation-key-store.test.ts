import { describe, expect, it } from 'vitest';

import {
  createRetainedOperationKeys,
  RETAINED_OPERATION_KEY_LIMIT,
  type RetainedOperationKeys,
} from './operation-key-store';

/** A mint that names each key by its ordinal, so a test can tell them apart. */
function countingMint(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `key-${n}`;
  };
}

/** The key a fingerprint holds; a refusal is a test failure, never a silent skip. */
function heldKey(keys: RetainedOperationKeys, fingerprint: string): string {
  const key = keys.getKey(fingerprint);
  if (key === null) {
    throw new Error(`no operation key was admitted for ${fingerprint}`);
  }
  return key;
}

describe('createRetainedOperationKeys', () => {
  it('keeps an unresolved fingerprint’s key no matter how many other intents arrive', () => {
    const keys = createRetainedOperationKeys(countingMint());
    const original = heldKey(keys, 'merge-1');

    for (let index = 0; index < 200; index += 1) {
      keys.getKey(`merge-${String(index + 2)}`);
    }

    // No eviction: capacity pressure must never drop an intent whose outcome is
    // still unknown, which would mint a replacement for the same merge.
    expect(heldKey(keys, 'merge-1')).toBe(original);
  });

  it('replaces every key at the account boundary', () => {
    const keys = createRetainedOperationKeys(countingMint());
    const before = heldKey(keys, 'merge-1');
    heldKey(keys, 'merge-2');

    keys.clear();

    expect(heldKey(keys, 'merge-1')).not.toBe(before);
  });

  it('gives different fingerprints different keys, and a retired one starts fresh', () => {
    const keys = createRetainedOperationKeys(countingMint());

    const first = heldKey(keys, 'merge-1');
    const second = heldKey(keys, 'merge-2');
    expect(second).not.toBe(first);

    keys.retireKey('merge-1', first);

    expect(heldKey(keys, 'merge-1')).not.toBe(first);
    // Retiring one intent leaves the others exactly as they were.
    expect(heldKey(keys, 'merge-2')).toBe(second);
  });

  it('retires a fingerprint only while the stored key is the one it captured', () => {
    const keys = createRetainedOperationKeys(countingMint());
    const accountA = heldKey(keys, 'merge-1');

    // Account A's request outlives the account boundary; account B admits the
    // same fingerprint with a key of its own and its request stays unresolved.
    keys.clear();
    const accountB = heldKey(keys, 'merge-1');
    expect(accountB).not.toBe(accountA);

    // A's late terminal outcome names A's key, so it must not delete B's entry:
    // doing so would mint B a replacement key and replay the merge.
    keys.retireKey('merge-1', accountA);
    expect(heldKey(keys, 'merge-1')).toBe(accountB);

    // B's own outcome is the authoritative retirement of B's entry.
    keys.retireKey('merge-1', accountB);
    expect(heldKey(keys, 'merge-1')).not.toBe(accountB);
  });

  it('refuses a new intent once it is full instead of evicting an unresolved one', () => {
    const keys = createRetainedOperationKeys(countingMint());
    const first = heldKey(keys, 'merge-1');
    const second = heldKey(keys, 'merge-2');
    for (let index = 3; index <= RETAINED_OPERATION_KEY_LIMIT; index += 1) {
      heldKey(keys, `merge-${String(index)}`);
    }

    // At the bound a brand-new intent is refused: nothing unresolved is dropped
    // to make room, and an admitted intent keeps the key it was given.
    expect(keys.getKey('merge-overflow')).toBeNull();
    expect(heldKey(keys, 'merge-1')).toBe(first);

    // An authoritative retirement is the only way back in, and it reclaims the
    // one slot that intent held.
    keys.retireKey('merge-2', second);
    expect(keys.getKey('merge-overflow')).not.toBeNull();
  });
});
