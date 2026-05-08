import { describe, test, expect } from '@jest/globals';
import { normalizePrBadgeState, truncatePrTitle } from './github-pr-link';

describe('normalizePrBadgeState', () => {
  test('merged stays merged', () => {
    expect(normalizePrBadgeState('merged')).toBe('merged');
  });
  test('open stays open', () => {
    expect(normalizePrBadgeState('open')).toBe('open');
  });
  test('closed stays closed', () => {
    expect(normalizePrBadgeState('closed')).toBe('closed');
  });
  test('unknown state collapses to closed', () => {
    expect(normalizePrBadgeState('weird-state')).toBe('closed');
  });
});

describe('truncatePrTitle', () => {
  test('returns empty for null', () => {
    expect(truncatePrTitle(null)).toBe('');
  });

  test('returns untruncated when within limit', () => {
    expect(truncatePrTitle('short title')).toBe('short title');
  });

  test('truncates with ellipsis when too long', () => {
    const long = 'a'.repeat(100);
    const out = truncatePrTitle(long, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });
});
