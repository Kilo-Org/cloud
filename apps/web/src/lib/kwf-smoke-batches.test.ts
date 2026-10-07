import { batchCount, toBatches } from './kwf-smoke-batches';

describe('toBatches', () => {
  it('gives null for an empty list', () => {
    expect(toBatches([], 2)).toBeNull();
  });

  it('keeps every item in order', () => {
    expect(toBatches([1, 2, 3], 2)?.flat()).toEqual([1, 2, 3]);
  });
});

describe('batchCount', () => {
  it('counts full batches', () => {
    expect(batchCount(4, 2)).toBe(2);
  });
});
