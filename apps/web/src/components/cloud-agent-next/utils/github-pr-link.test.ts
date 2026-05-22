import { describe, test, expect } from '@jest/globals';
import { normalizePrBadgeState, prAccentColor, truncatePrTitle } from './github-pr-link';

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
  test('draft stays draft', () => {
    expect(normalizePrBadgeState('draft')).toBe('draft');
  });
  test('unknown state collapses to closed', () => {
    expect(normalizePrBadgeState('weird-state')).toBe('closed');
  });
});

describe('prAccentColor', () => {
  test('merged returns purple', () => {
    expect(prAccentColor('merged', null)).toBe('var(--color-purple-400)');
  });
  test('closed returns zinc', () => {
    expect(prAccentColor('closed', null)).toBe('var(--color-zinc-400)');
  });
  test('draft returns zinc', () => {
    expect(prAccentColor('draft', null)).toBe('var(--color-zinc-400)');
  });
  test('open with no review decision returns zinc', () => {
    expect(prAccentColor('open', null)).toBe('var(--color-zinc-400)');
  });
  test('open approved returns emerald', () => {
    expect(prAccentColor('open', 'approved')).toBe('var(--color-emerald-400)');
  });
  test('open changes_requested returns amber', () => {
    expect(prAccentColor('open', 'changes_requested')).toBe('var(--color-amber-400)');
  });
  test('open review_required returns zinc', () => {
    expect(prAccentColor('open', 'review_required')).toBe('var(--color-zinc-400)');
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
