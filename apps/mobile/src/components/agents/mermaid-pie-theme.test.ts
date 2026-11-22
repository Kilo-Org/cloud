import { describe, expect, it } from 'vitest';

import {
  DARK_PIE_FILLS,
  DARK_PIE_SECTION_INK,
  DARK_PIE_STROKE_COLOR,
  darkPieThemeVariables,
} from './mermaid-pie-theme';
import { darkColors } from '@/lib/hooks/theme-colors.generated';
import { compositeOver, relativeLuminance } from '@/lib/pr-review/diff/syntax-colors';

/** The dark diagram page the fills are painted on: the same composition
 * `markdown-palette` makes for a dark diagram. Derived from the tokens rather
 * than restated, so a change to `background` or `card` fails here instead of
 * leaving the module painting a page that no longer exists. */
const DARK_DIAGRAM_PAGE = compositeOver(darkColors.background, darkColors.card);

const MIN_TEXT_RATIO = 4.5;

/** WCAG 2.x contrast of two colours the shipped luminance helper parses. */
function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) {
    throw new Error(`contrastRatio needs two parseable hex colors: ${foreground}, ${background}`);
  }
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('dark pie fills', () => {
  it('paints twelve distinct slices', () => {
    expect(DARK_PIE_FILLS).toHaveLength(12);
    expect(new Set(DARK_PIE_FILLS).size).toBe(12);
  });

  it('clears WCAG AA text contrast on the diagram page', () => {
    for (const fill of DARK_PIE_FILLS) {
      const ratio = contrastRatio(fill, DARK_DIAGRAM_PAGE);
      expect(
        ratio,
        `${fill} on the dark diagram page ${DARK_DIAGRAM_PAGE} is ${ratio.toFixed(2)}:1, below the ${MIN_TEXT_RATIO}:1 text bar`
      ).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });

  it('clears WCAG AA text contrast on the section ink', () => {
    // The percentage text is painted in this ink on the slice, so it is the pair
    // that has to hold, not just the fill against the page.
    for (const fill of DARK_PIE_FILLS) {
      const ratio = contrastRatio(fill, DARK_PIE_SECTION_INK);
      expect(
        ratio,
        `${fill} against the section ink ${DARK_PIE_SECTION_INK} is ${ratio.toFixed(2)}:1, below the ${MIN_TEXT_RATIO}:1 text bar`
      ).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });

  it('takes the page colour for both the ink and the stroke', () => {
    // One surface, two jobs: the ink reads as a cut-out of a light slice, and the
    // stroke parts neighbouring wedges. Neither may drift to a second colour.
    expect(DARK_PIE_SECTION_INK).toBe(DARK_DIAGRAM_PAGE);
    expect(DARK_PIE_STROKE_COLOR).toBe(DARK_DIAGRAM_PAGE);
  });
});

describe('dark pie theme variables', () => {
  it('maps the twelve fills onto pie1..pie12', () => {
    const variables = darkPieThemeVariables();

    for (const [index, fill] of DARK_PIE_FILLS.entries()) {
      expect(variables[`pie${index + 1}`]).toBe(fill);
    }
    expect(Object.keys(variables)).toHaveLength(15);
  });

  it('states the section ink, full opacity and the slice stroke', () => {
    const variables = darkPieThemeVariables();

    expect(variables.pieSectionTextColor).toBe(DARK_PIE_SECTION_INK);
    // Mermaid's own 0.7 opacity would let the page tint every slice.
    expect(variables.pieOpacity).toBe('1');
    expect(variables.pieStrokeColor).toBe(DARK_PIE_STROKE_COLOR);
  });

  it('returns a fresh map per call', () => {
    const first = darkPieThemeVariables();
    const second = darkPieThemeVariables();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});
