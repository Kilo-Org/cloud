import { batchCount, toBatches } from './kwf-smoke-batches';

describe('toBatches', () => {
  it('gives null for an empty list', () => {
    expect(toBatches([], 2)).toBeNull();
  });

  it('keeps every item in order', () => {
    expect(toBatches([1, 2, 3], 2)?.flat()).toEqual([1, 2, 3]);
  });

  it('gives no trailing empty batch for an exact multiple', () => {
    expect(toBatches([1, 2], 2)).toEqual([[1, 2]]);
  });

  it('rejects a size below 1', () => {
    expect(() => toBatches([1], 0)).toThrow(RangeError);
    expect(() => toBatches([1], -1)).toThrow(RangeError);
  });
});

describe('batchCount', () => {
  it('counts full batches', () => {
    expect(batchCount(4, 2)).toBe(2);
  });

  it('rounds up a partial batch', () => {
    expect(batchCount(3, 2)).toBe(2);
  });

  it('rejects a size below 1', () => {
    expect(() => batchCount(3, 0)).toThrow(RangeError);
  });
});
