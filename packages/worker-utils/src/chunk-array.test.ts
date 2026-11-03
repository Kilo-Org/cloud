import { describe, it, expect } from 'vitest';
import { chunkArray } from './chunk-array.js';

describe('chunkArray', () => {
  it('throws when chunk size is 0', () => {
    expect(() => chunkArray([1, 2, 3], 0)).toThrow('size must be a positive whole number');
  });

  it('throws when chunk size is negative', () => {
    expect(() => chunkArray([1, 2, 3], -1)).toThrow('size must be a positive whole number');
  });

  it('throws when chunk size is not an integer', () => {
    expect(() => chunkArray([1, 2, 3], 1.5)).toThrow('size must be a positive whole number');
  });

  it('returns no chunks when array is empty', () => {
    expect(chunkArray([], 3)).toEqual([]);
  });

  it('chunks [1,2,3,4,5,6] with size 3 into [[1,2,3],[4,5,6]]', () => {
    expect(chunkArray([1, 2, 3, 4, 5, 6], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('chunks [1,2,3,4,5] with size 2 into [[1,2],[3,4],[5]]', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('accepts readonly arrays', () => {
    const readonlyArray: readonly number[] = [1, 2, 3];
    expect(chunkArray(readonlyArray, 2)).toEqual([[1, 2], [3]]);
  });
});
