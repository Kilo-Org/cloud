import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';
import { compositeOver } from '@/lib/pr-review/diff/syntax-colors';

import { DARK_PIE_FILLS, LIGHT_PIE_FILLS, pieThemeVariables } from './mermaid-pie-fills';

/**
 * The pie chart theme for mermaid's diagram pages: the ramps and the map live in
 * `mermaid-pie-fills.ts` (which imports nothing, so the web app's TypeScript
 * program can read it), and this module names the pages they are measured
 * against.
 *
 * Each ramp carries the default palette's hues, restated for the page it paints
 * on: a pie chart names its series in the same hue family in both modes, and only
 * the lightness and saturation change with the page.
 *
 * Both pages need one. Mermaid's default palette is pastel, so on the light
 * diagram page `pie1` is `#ECECFF` at 1.12:1 and `pie2` `#FFFFDE` at 1.03:1: a
 * Working or Idle slice and its legend swatch nearly vanish. The dark page has
 * the mirror-image defect, its own theme putting the first slice near the page
 * colour, which the dark ramp answers by muting and lifting the same hues. The
 * light ramp states the same hues darker, so one series is the same colour in
 * both modes.
 */

/** The dark diagram page: the same composition `markdown-palette` makes for a
 * dark diagram, taken from the tokens rather than restated, so the fills are
 * always measured against the page the app really paints. */
const DARK_PIE_SURFACE = compositeOver(darkColors.background, darkColors.card);

/** The light diagram page: the same composition `markdown-palette` makes for a
 * light diagram, taken from the tokens rather than restated, so the fills are
 * always measured against the page the app really paints. */
const LIGHT_PIE_SURFACE = compositeOver(lightColors.background, lightColors.card);

export { DARK_PIE_FILLS, LIGHT_PIE_FILLS } from './mermaid-pie-fills';

export const DARK_PIE_STROKE_COLOR = DARK_PIE_SURFACE;

export const DARK_PIE_SECTION_INK = DARK_PIE_SURFACE;

export const LIGHT_PIE_STROKE_COLOR = LIGHT_PIE_SURFACE;

export const LIGHT_PIE_SECTION_INK = LIGHT_PIE_SURFACE;

/**
 * The `themeVariables` overrides a dark diagram passes to `mermaid.initialize`.
 * A fresh object per call: the caller memoises it, so no two diagrams share one
 * mutable map.
 */
export function darkPieThemeVariables(): Record<string, string> {
  return pieThemeVariables(DARK_PIE_FILLS, DARK_PIE_SURFACE);
}

/**
 * The `themeVariables` overrides a light diagram passes to `mermaid.initialize`.
 * A fresh object per call: the caller memoises it, so no two diagrams share one
 * mutable map.
 */
export function lightPieThemeVariables(): Record<string, string> {
  return pieThemeVariables(LIGHT_PIE_FILLS, LIGHT_PIE_SURFACE);
}
