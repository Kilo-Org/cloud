import { chunkArray } from './chunkArray';

describe('chunkArray', () => {
  it('throws when chunk size is 0', () => {
    expect(() => chunkArray([1, 2, 3], 0)).toThrow('size must be a positive whole number');
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
});
