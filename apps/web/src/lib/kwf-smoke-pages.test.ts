import { pageNumbers, pageOf, pageSlice } from './kwf-smoke-pages';

describe('pageNumbers', () => {
  it('gives page 1 for zero items', () => {
    expect(pageNumbers(0, 10)).toEqual([1]);
  });

  it('counts a partial last page', () => {
    expect(pageNumbers(21, 10)).toEqual([1, 2, 3]);
  });
});

describe('pageSlice', () => {
  it('reads page 1 from the first item', () => {
    expect(pageSlice([1, 2, 3], 1, 2)).toEqual([1, 2]);
  });
});

describe('pageOf', () => {
  it('returns a number for the page that holds an item', () => {
    expect(pageOf(0, 10)).toBe(1);
    expect(pageOf(10, 10)).toBe(2);
    expect(pageOf(21, 10)).toBe(3);
  });
});
