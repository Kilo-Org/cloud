import { describe, expect, it } from 'vitest';
import { formatElapsed } from './format-elapsed';

describe('formatElapsed', () => {
  it('renders sub-second durations as 0s', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
  });

  it('renders seconds only', () => {
    expect(formatElapsed(4_139)).toBe('4s');
  });

  it('omits zero units between larger ones', () => {
    expect(formatElapsed(60 * 60 * 1_000)).toBe('1h');
  });

  it('renders hours, minutes, and seconds together', () => {
    expect(formatElapsed(3_723_000)).toBe('1h 2m 3s');
  });
});
