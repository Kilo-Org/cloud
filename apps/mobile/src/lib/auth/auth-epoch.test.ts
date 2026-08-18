import { describe, expect, it } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch, isCurrentAuthEpoch } from './auth-epoch';

describe('auth-epoch', () => {
  it('starts with a current epoch', () => {
    expect(isCurrentAuthEpoch(currentAuthEpoch())).toBe(true);
  });

  it('bumpAuthEpoch invalidates the prior epoch', () => {
    const prior = currentAuthEpoch();
    bumpAuthEpoch();
    expect(isCurrentAuthEpoch(prior)).toBe(false);
    expect(isCurrentAuthEpoch(currentAuthEpoch())).toBe(true);
  });

  it('moves the epoch forward on each bump', () => {
    const before = currentAuthEpoch();
    bumpAuthEpoch();
    bumpAuthEpoch();
    expect(currentAuthEpoch()).toBeGreaterThan(before);
  });
});
