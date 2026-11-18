import { describe, expect, it } from 'vitest';

import { isLatestMutationGeneration, nextMutationGeneration } from './mutation-generations';

describe('mutation-generations', () => {
  it('increments per key and returns the new generation', () => {
    expect(nextMutationGeneration('a')).toBe(1);
    expect(nextMutationGeneration('a')).toBe(2);
    expect(nextMutationGeneration('b')).toBe(1);
  });

  it('tracks keys independently', () => {
    nextMutationGeneration('x');
    nextMutationGeneration('y');
    nextMutationGeneration('y');
    expect(isLatestMutationGeneration('x', 1)).toBe(true);
    expect(isLatestMutationGeneration('y', 2)).toBe(true);
  });

  it('isLatestMutationGeneration is true only for the latest generation', () => {
    const first = nextMutationGeneration('key');
    const second = nextMutationGeneration('key');
    expect(isLatestMutationGeneration('key', second)).toBe(true);
    expect(isLatestMutationGeneration('key', first)).toBe(false);
  });

  it('returns false for a key with no generation yet', () => {
    expect(isLatestMutationGeneration('untouched', 1)).toBe(false);
  });
});
