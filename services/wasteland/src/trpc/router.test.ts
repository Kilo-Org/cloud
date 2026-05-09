import { describe, it, expect } from 'vitest';
import { inferPrKind } from './claims.util';

describe('inferPrKind', () => {
  it('detects claim from title', () => {
    expect(inferPrKind('wl claim: w-abc123')).toBe('claim');
  });

  it('detects done from title', () => {
    expect(inferPrKind('wl done: w-abc123')).toBe('done');
  });

  it('detects unclaim from title', () => {
    expect(inferPrKind('wl unclaim: w-abc123')).toBe('unclaim');
  });

  it('detects edit from "update" keyword', () => {
    expect(inferPrKind('wl update: w-abc123')).toBe('edit');
  });

  it('detects edit from "edit" keyword', () => {
    expect(inferPrKind('Edit wanted item w-abc123')).toBe('edit');
  });

  it('returns unknown for unrecognized titles', () => {
    expect(inferPrKind('Some random PR title')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(inferPrKind('WL CLAIM: w-abc123')).toBe('claim');
    expect(inferPrKind('WL Done: w-abc123')).toBe('done');
  });

  it('prefers unclaim over claim (unclaim checked first)', () => {
    expect(inferPrKind('wl unclaim: w-abc123')).toBe('unclaim');
  });

  it('prefers done over claim when both present', () => {
    expect(inferPrKind('wl done: w-abc123 after claim')).toBe('done');
  });
});
