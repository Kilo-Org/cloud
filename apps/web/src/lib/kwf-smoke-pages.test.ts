import { pageNumbers } from './kwf-smoke-pages';

describe('pageNumbers', () => {
  it('gives page 1 for zero items', () => {
    expect(pageNumbers(0, 10)).toEqual([1]);
  });

  it('counts a partial last page', () => {
    expect(pageNumbers(21, 10)).toEqual([1, 2, 3]);
  });
});
