// Unit tests for the bounded font-scale metrics that drive the PR
// diff surface (P1-C-22). The metrics cap `useWindowDimensions().fontScale`
// at `DIFF_MAX_FONT_SCALE` so the diff layout (gutter, side-by-side
// grid) stays intact even at the largest accessibility scale.

// The metrics describe the actual rendered result: the `Text` nodes in
// the diff rows set `maxFontSizeMultiplier={DIFF_MAX_FONT_SCALE}` and
// supply UNSCALED base font sizes / line heights. The native pipeline
// applies the bounded scale exactly once; the JS side only pre-scales
// `rowMinHeight` so the row always fits the capped text + padding.

import {
  type BoundedFontMetrics,
  computeBoundedDiffFontMetrics,
  DIFF_BASE_LINE_HEIGHT,
  DIFF_BASE_ROW_MIN_HEIGHT,
  DIFF_CODE_BASE_FONT_SIZE,
  DIFF_LABEL_BASE_FONT_SIZE,
  DIFF_MAX_FONT_SCALE,
  DIFF_VERTICAL_PADDING,
  useBoundedDiffFontMetrics,
} from './diff-font-metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const windowDimensionsState = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({
    fontScale: windowDimensionsState.fontScale,
    width: 390,
    height: 844,
    scale: 2,
  }),
}));

describe('computeBoundedDiffFontMetrics', () => {
  it('returns base sizes when the system reports a 1.0 scale', () => {
    const m = computeBoundedDiffFontMetrics(1);
    expect(m.scale).toBe(1);
    expect(m.codeFontSize).toBe(DIFF_CODE_BASE_FONT_SIZE);
    expect(m.labelFontSize).toBe(DIFF_LABEL_BASE_FONT_SIZE);
    expect(m.lineHeight).toBe(DIFF_BASE_LINE_HEIGHT);
    expect(m.rowMinHeight).toBe(DIFF_BASE_ROW_MIN_HEIGHT);
  });

  it('keeps text dimensions unscaled; rowMinHeight grows with the bounded scale', () => {
    const m = computeBoundedDiffFontMetrics(1.18);
    expect(m.scale).toBe(1.18);
    expect(m.codeFontSize).toBe(DIFF_CODE_BASE_FONT_SIZE);
    expect(m.labelFontSize).toBe(DIFF_LABEL_BASE_FONT_SIZE);
    expect(m.lineHeight).toBe(DIFF_BASE_LINE_HEIGHT);
    expect(m.rowMinHeight).toBeCloseTo(DIFF_BASE_LINE_HEIGHT * 1.18 + DIFF_VERTICAL_PADDING * 2, 5);
  });

  it('caps at DIFF_MAX_FONT_SCALE and still keeps text dimensions unscaled', () => {
    const m = computeBoundedDiffFontMetrics(1.8);
    expect(m.scale).toBe(DIFF_MAX_FONT_SCALE);
    expect(m.codeFontSize).toBe(DIFF_CODE_BASE_FONT_SIZE);
    expect(m.labelFontSize).toBe(DIFF_LABEL_BASE_FONT_SIZE);
    expect(m.lineHeight).toBe(DIFF_BASE_LINE_HEIGHT);
    expect(m.rowMinHeight).toBeCloseTo(
      DIFF_BASE_LINE_HEIGHT * DIFF_MAX_FONT_SCALE + DIFF_VERTICAL_PADDING * 2,
      5
    );
  });

  it('clamps an absurdly large system scale to the cap', () => {
    const m = computeBoundedDiffFontMetrics(5);
    expect(m.scale).toBe(DIFF_MAX_FONT_SCALE);
  });

  it('treats invalid input (null / undefined / non-finite) as 1.0', () => {
    expect(computeBoundedDiffFontMetrics(null).scale).toBe(1);
    expect(computeBoundedDiffFontMetrics(undefined).scale).toBe(1);
    expect(computeBoundedDiffFontMetrics(Number.NaN).scale).toBe(1);
    expect(computeBoundedDiffFontMetrics(Number.POSITIVE_INFINITY).scale).toBe(1);
  });

  it('clamps sub-1 input (e.g. tiny font preference) up to 1.0', () => {
    const m = computeBoundedDiffFontMetrics(0.85);
    expect(m.scale).toBe(1);
    expect(m.codeFontSize).toBeCloseTo(DIFF_CODE_BASE_FONT_SIZE, 5);
  });

  it('keeps row height >= base so scaled text is never clipped', () => {
    for (const scale of [1, 1.18, 1.4]) {
      const m = computeBoundedDiffFontMetrics(scale);
      expect(m.rowMinHeight).toBeGreaterThanOrEqual(DIFF_BASE_ROW_MIN_HEIGHT);
      // lineHeight stays at the unscaled base; the native maxFontSizeMultiplier
      // scales the actual line box. rowMinHeight must cover that scaled box.
      expect(m.lineHeight).toBe(DIFF_BASE_LINE_HEIGHT);
    }
  });

  it('keeps the row exactly as tall as the capped text plus padding at every scale', () => {
    // The production formula: rowMinHeight = lineHeight * scale + 2 * padding.
    // lineHeight is unscaled; the native maxFontSizeMultiplier scales it by
    // `scale` at render time. This test guards against accidental padding
    // scaling or double-counting that could clip the code text.
    for (const scale of [1, 1.05, 1.18, 1.25, 1.4]) {
      const m = computeBoundedDiffFontMetrics(scale);
      expect(m.rowMinHeight).toBeCloseTo(
        DIFF_BASE_LINE_HEIGHT * scale + DIFF_VERTICAL_PADDING * 2,
        5
      );
      expect(m.rowMinHeight).toBeCloseTo(m.lineHeight * m.scale + DIFF_VERTICAL_PADDING * 2, 5);
    }
  });

  it('describes the actual rendered result: text is scaled once by the native pipeline', () => {
    // The diff rows set `maxFontSizeMultiplier={DIFF_MAX_FONT_SCALE}` on
    // `Text` nodes and supply these unscaled base values. The effective
    // rendered size is base * boundedScale, applied exactly once by RN.
    // rowMinHeight must fit that single-scaled line box + padding.
    const m = computeBoundedDiffFontMetrics(1.8);
    expect(m.scale).toBe(DIFF_MAX_FONT_SCALE);
    expect(m.codeFontSize).toBe(DIFF_CODE_BASE_FONT_SIZE);
    expect(m.labelFontSize).toBe(DIFF_LABEL_BASE_FONT_SIZE);
    expect(m.lineHeight).toBe(DIFF_BASE_LINE_HEIGHT);
    expect(m.rowMinHeight).toBeCloseTo(m.lineHeight * m.scale + DIFF_VERTICAL_PADDING * 2, 5);
  });

  it('returns a BoundedFontMetrics type that callers can use', () => {
    const m: BoundedFontMetrics = computeBoundedDiffFontMetrics(DIFF_MAX_FONT_SCALE);
    expect(m.scale).toBe(DIFF_MAX_FONT_SCALE);
  });
});

describe('useBoundedDiffFontMetrics', () => {
  beforeEach(() => {
    windowDimensionsState.fontScale = 1;
  });
  afterEach(() => {
    windowDimensionsState.fontScale = 1;
  });

  it('reflects changes to useWindowDimensions().fontScale', () => {
    windowDimensionsState.fontScale = 1.18;
    const m1 = useBoundedDiffFontMetrics();
    expect(m1.scale).toBe(1.18);

    windowDimensionsState.fontScale = 1.8;
    const m2 = useBoundedDiffFontMetrics();
    expect(m2.scale).toBe(DIFF_MAX_FONT_SCALE);
  });
});
