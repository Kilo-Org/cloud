import { range } from './kwf-experiment-ranges';

describe('range', () => {
  it('includes both ends', () => {
    expect(range(1, 3)).toEqual([1, 2, 3]);
  });

  it('gives an empty list when end is before start', () => {
    expect(range(3, 1)).toEqual([]);
  });

  it('skips values by step', () => {
    expect(range(0, 6, 3)).toEqual([0, 3, 6]);
  });

  it('rejects a zero step instead of looping forever', () => {
    expect(() => range(0, 6, 0)).toThrow('range step must be a positive integer');
  });

  it('rejects a negative step instead of looping forever', () => {
    expect(() => range(0, 6, -1)).toThrow('range step must be a positive integer');
  });

  it('rejects a non-integer step', () => {
    expect(() => range(0, 6, 0.5)).toThrow('range step must be a positive integer');
  });
});
