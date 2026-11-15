import { describe, expect, it } from 'vitest';

import { createRetainedOperationKeys } from './operation-key-store';

/** A mint that names each key by its ordinal, so a test can tell them apart. */
function countingMint(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `key-${n}`;
  };
}

describe('createRetainedOperationKeys', () => {
  it('keeps an unresolved fingerprint’s key no matter how many other intents arrive', () => {
    const keys = createRetainedOperationKeys(countingMint());
    const original = keys.getKey('merge-1');

    for (let index = 0; index < 200; index += 1) {
      keys.getKey(`merge-${String(index + 2)}`);
    }

    // No eviction: capacity pressure must never drop an intent whose outcome is
    // still unknown, which would mint a replacement for the same merge.
    expect(keys.getKey('merge-1')).toBe(original);
  });

  it('replaces every key at the account boundary', () => {
    const keys = createRetainedOperationKeys(countingMint());
    const before = keys.getKey('merge-1');
    keys.getKey('merge-2');

    keys.clear();

    expect(keys.getKey('merge-1')).not.toBe(before);
  });

  it('gives different fingerprints different keys, and a retired one starts fresh', () => {
    const keys = createRetainedOperationKeys(countingMint());

    const first = keys.getKey('merge-1');
    const second = keys.getKey('merge-2');
    expect(second).not.toBe(first);

    keys.retireKey('merge-1', first);

    expect(keys.getKey('merge-1')).not.toBe(first);
    // Retiring one intent leaves the others exactly as they were.
    expect(keys.getKey('merge-2')).toBe(second);
  });

  it('retires a fingerprint only while the stored key is the one it captured', () => {
    const keys = createRetainedOperationKeys(countingMint());
    const accountA = keys.getKey('merge-1');
    keys.clear();
    const accountB = keys.getKey('merge-1');
    keys.retireKey('merge-1', accountA);
    expect(keys.getKey('merge-1')).toBe(accountB);
    keys.retireKey('merge-1', accountB);
    expect(keys.getKey('merge-1')).not.toBe(accountB);
  });
});
