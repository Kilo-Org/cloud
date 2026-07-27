// Bounded font-scale metrics for the PR diff surface.
//
// The PR diff renders thousands of JetBrains Mono lines in a tight
// 56-point gutter and a 2-column side-by-side grid. Honouring the
// user's accessibility font scale verbatim (iOS Dynamic Type can reach
// ~1.8x at AX5) would either overflow the gutter, break the side-by-
// side alignment, or destroy the diff's visual density.
//
// We scale text by a BOUNDED `useWindowDimensions().fontScale` so a11y users
// still get meaningfully larger text, but the cap keeps the diff
// surface legible. The cap is intentionally below the iOS large-text
// step (1.18) and the system max — see `MAX_FONT_SCALE` below.
//
// Cap rationale (chosen 2026-07 for P1-C-22):
//   * 1.0  → disables a11y (the prior `allowFontScaling={false}`).
//   * 1.18 → iOS large-text default. Diff text barely moves.
//   * 1.4  → our cap. ~19% larger than iOS large-text, 19% smaller
//            than the system max. Preserves gutter + side-by-side
//            grid; matches the diff density that defines the UX.
//   * 1.8+ → gutter overflow + side-by-side misalignment.

import { createContext, useContext } from 'react';
import { useWindowDimensions } from 'react-native';

/**
 * Maximum font scale honoured by the PR diff surface. The cap is
 * applied to `useWindowDimensions().fontScale`; values below the cap
 * are passed through so a11y users see their preferred scale.
 *
 * The same value is used as `maxFontSizeMultiplier` on diff `Text`
 * nodes so the native pipeline applies the bounded scale exactly once.
 *
 * Documented at 1.4. See file header for the full rationale.
 */
export const DIFF_MAX_FONT_SCALE = 1.4;

/** Minimum base font size for the code text in the diff (unscaled pt). */
export const DIFF_CODE_BASE_FONT_SIZE = 12;
/** Minimum base font size for gutter + "no newline" labels (unscaled pt). */
export const DIFF_LABEL_BASE_FONT_SIZE = 11;
/** Unscaled line height used for the code text. */
export const DIFF_BASE_LINE_HEIGHT = 18;
/** Unscaled vertical padding above + below the code text inside a row. */
export const DIFF_VERTICAL_PADDING = 2;
/** Unscaled minimum row height (lineHeight + 2 * vertical padding). */
export const DIFF_BASE_ROW_MIN_HEIGHT = DIFF_BASE_LINE_HEIGHT + DIFF_VERTICAL_PADDING * 2;

export type BoundedFontMetrics = {
  /** Clamped font scale actually applied by `maxFontSizeMultiplier` (0 < scale <= DIFF_MAX_FONT_SCALE). */
  readonly scale: number;
  /** Unscaled code font size in pt; the native `maxFontSizeMultiplier` applies `scale`. */
  readonly codeFontSize: number;
  /** Unscaled label (gutter / no-newline) font size in pt; the native `maxFontSizeMultiplier` applies `scale`. */
  readonly labelFontSize: number;
  /** Unscaled line height used for both code and label text; the native `maxFontSizeMultiplier` applies `scale`. */
  readonly lineHeight: number;
  /** Scaled minimum row height (lineHeight * scale + 2 * vertical padding). */
  readonly rowMinHeight: number;
};

/**
 * Pure, deterministic metric computation. Exported so tests can assert
 * the curve without rendering.
 *
 * The returned `codeFontSize`, `labelFontSize` and `lineHeight` are the
 * UNSCALED base values. The actual rendered size is produced by React
 * Native when `maxFontSizeMultiplier={DIFF_MAX_FONT_SCALE}` is set on
 * the `Text` node (the scale applied by the native pipeline is bounded
 * by `scale`). `rowMinHeight` is pre-scaled so the row always fits the
 * natively-capped text + vertical padding.
 */
export function computeBoundedDiffFontMetrics(
  fontScale: number | null | undefined
): BoundedFontMetrics {
  // Treat invalid / negative / non-finite input as 1.0 (no scaling).
  // `useWindowDimensions().fontScale` can be 1.0 on platforms that report
  // no accessibility preference; we should never produce sub-1 sizes.
  const raw = typeof fontScale === 'number' && Number.isFinite(fontScale) ? fontScale : 1;
  const scale = Math.min(Math.max(raw, 1), DIFF_MAX_FONT_SCALE);
  return {
    scale,
    codeFontSize: DIFF_CODE_BASE_FONT_SIZE,
    labelFontSize: DIFF_LABEL_BASE_FONT_SIZE,
    lineHeight: DIFF_BASE_LINE_HEIGHT,
    rowMinHeight: DIFF_BASE_LINE_HEIGHT * scale + DIFF_VERTICAL_PADDING * 2,
  };
}

const defaultMetrics = computeBoundedDiffFontMetrics(1);

/**
 * Context that carries the bounded diff font metrics down to individual
 * diff rows. The value is stable between font-scale changes, so rows
 * wrapped in `memo` only re-render when the scale actually changes.
 */
export const DiffFontMetricsContext = createContext<BoundedFontMetrics>(defaultMetrics);

/**
 * Hook for child rows to read the current bounded diff font metrics.
 * Falls back to the 1.0 metrics when rendered outside a provider.
 */
export function useDiffFontMetrics(): BoundedFontMetrics {
  return useContext(DiffFontMetricsContext);
}

const metricsCache = new Map<number, BoundedFontMetrics>();

/**
 * React hook wrapper that reads the reactive system font scale from
 * `useWindowDimensions().fontScale` and returns the bounded diff metrics.
 * The result is cached by its bounded scale so the returned reference is
 * stable between renders when the scale hasn't changed.
 */
export function useBoundedDiffFontMetrics(): BoundedFontMetrics {
  const { fontScale } = useWindowDimensions();
  const metrics = computeBoundedDiffFontMetrics(fontScale);
  const cached = metricsCache.get(metrics.scale);
  if (cached) {
    return cached;
  }
  metricsCache.set(metrics.scale, metrics);
  return metrics;
}
