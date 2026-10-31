import { formatMicrodollarCount, formatMicrodollarsAsUsd } from './format';

describe('formatMicrodollarsAsUsd', () => {
  it.each([
    ['0', '$0.000000'],
    ['1', '$0.000001'],
    ['1234567', '$1.234567'],
    ['9007199254740993', '$9,007,199,254.740993'],
    ['-250', '-$0.000250'],
  ])('formats %s microdollars exactly as %s', (input, expected) => {
    expect(formatMicrodollarsAsUsd(input)).toBe(expected);
  });
});

describe('formatMicrodollarCount', () => {
  it('groups digits without converting to a float', () => {
    expect(formatMicrodollarCount('9007199254740993')).toBe('9,007,199,254,740,993');
    expect(formatMicrodollarCount('-1234')).toBe('-1,234');
  });
});
