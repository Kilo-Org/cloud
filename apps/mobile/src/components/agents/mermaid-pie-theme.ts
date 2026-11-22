import { darkColors } from '@/lib/hooks/theme-colors.generated';
import { compositeOver } from '@/lib/pr-review/diff/syntax-colors';

import { pieThemeVariables } from './mermaid-pie-fills';

/**
 * The pie chart theme for mermaid's dark diagram page: the ramp and the map
 * live in `mermaid-pie-fills.ts` (which imports nothing, so the web app's
 * TypeScript program can read it), and this module names the page they are
 * measured against.
 *
 * Light mode is out of scope here, and carries the same defect: mermaid's
 * light theme derives `pie1` as `#ECECFF`, which is 1.12:1 on the light
 * diagram page. It needs its own ramp against that page, and its own ink for
 * the fills that ramp would use, so it is deliberately not changed here.
 */

/** The dark diagram page: the same composition `markdown-palette` makes for a
 * dark diagram, taken from the tokens rather than restated, so the fills are
 * always measured against the page the app really paints. */
const DARK_PIE_SURFACE = compositeOver(darkColors.background, darkColors.card);

export { DARK_PIE_FILLS } from './mermaid-pie-fills';

export const DARK_PIE_STROKE_COLOR = DARK_PIE_SURFACE;

export const DARK_PIE_SECTION_INK = DARK_PIE_SURFACE;

/**
 * The `themeVariables` overrides a dark diagram passes to `mermaid.initialize`.
 * A fresh object per call: the caller memoises it, so no two diagrams share one
 * mutable map.
 */
export function darkPieThemeVariables(): Record<string, string> {
  return pieThemeVariables(DARK_PIE_SURFACE);
}
