import { describe, expect, it } from 'vitest';

import {
  PR_DIFF_FLOATING_ACTIONS_FALLBACK_HEIGHT,
  PR_DIFF_LIST_FOOTER_GAP,
  prDiffListBottomPadding,
} from '@/lib/pr-review/diff/pr-diff-list-bottom-padding';

const FALLBACK = PR_DIFF_FLOATING_ACTIONS_FALLBACK_HEIGHT + PR_DIFF_LIST_FOOTER_GAP;

describe('prDiffListBottomPadding', () => {
  it('returns fallback + gap when barHeight is null', () => {
    expect(prDiffListBottomPadding(null)).toBe(120);
  });

  it('returns fallback + gap when barHeight is zero', () => {
    expect(prDiffListBottomPadding(0)).toBe(120);
  });

  it('returns fallback + gap when barHeight is negative', () => {
    expect(prDiffListBottomPadding(-5)).toBe(120);
  });

  it('returns rounded height + gap for a positive integer', () => {
    // 80 + 12
    expect(prDiffListBottomPadding(80)).toBe(92);
  });

  it('rounds a decimal height down to the nearest integer', () => {
    // round(71.2) + 12 = 71 + 12
    expect(prDiffListBottomPadding(71.2)).toBe(83);
  });

  it('rounds a decimal height up to the nearest integer', () => {
    // round(71.8) + 12 = 72 + 12
    expect(prDiffListBottomPadding(71.8)).toBe(84);
  });

  it('grows with a taller bar', () => {
    // 120 + 12
    expect(prDiffListBottomPadding(120)).toBe(132);
    // 200 + 12
    expect(prDiffListBottomPadding(200)).toBe(212);
  });

  it('has the correct exported constants', () => {
    expect(PR_DIFF_LIST_FOOTER_GAP).toBe(12);
    expect(PR_DIFF_FLOATING_ACTIONS_FALLBACK_HEIGHT).toBe(108);
    expect(FALLBACK).toBe(120);
  });
});
