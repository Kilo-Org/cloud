import { spendBarHeightPercent } from './formatting';

describe('Cost Insights formatting', () => {
  it('keeps zero-spend chart buckets at zero height', () => {
    expect(spendBarHeightPercent(0, 100)).toBe(0);
  });

  it('keeps a visible minimum for nonzero chart buckets', () => {
    expect(spendBarHeightPercent(0.1, 100)).toBe(2);
  });
});
