import { expect, it } from 'vitest';
import { seededEntropy } from './seeded.js';

it('gives the same bytes for the same seed', () => {
  expect([...seededEntropy(42).bytes(32)]).toEqual([...seededEntropy(42).bytes(32)]);
});

it('gives different bytes for different seeds', () => {
  expect([...seededEntropy(1).bytes(32)]).not.toEqual([...seededEntropy(2).bytes(32)]);
});

it('keeps going rather than repeating one byte', () => {
  const drawn = new Set(seededEntropy(7).bytes(256));
  /* A generator stuck on one value would still pass a determinism check, and
     would then hand every identifier the same random part. */
  expect(drawn.size).toBeGreaterThan(64);
});

it('accepts a zero seed without collapsing', () => {
  expect(new Set(seededEntropy(0).bytes(64)).size).toBeGreaterThan(16);
});
