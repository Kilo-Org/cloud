import { describe, expect, it } from '@jest/globals';
import { formatBodySizeKilobytes } from './auto-routing-format';

describe('auto routing admin formatting', () => {
  it('formats body bytes as kilobytes with two decimals', () => {
    expect(formatBodySizeKilobytes(0)).toBe('0.00 KB');
    expect(formatBodySizeKilobytes(1536)).toBe('1.50 KB');
    expect(formatBodySizeKilobytes(2048)).toBe('2.00 KB');
    expect(formatBodySizeKilobytes(10_485_760)).toBe('10,240.00 KB');
  });
});
