import { range } from './kwf-experiment-ranges';

describe('range', () => {
  it('includes both ends', () => {
    expect(range(1, 3)).toEqual([1, 2, 3]);
  });

  it('gives an empty list when end is before start', () => {
    expect(range(3, 1)).toEqual([]);
  });
});
