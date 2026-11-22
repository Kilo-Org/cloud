/**
 * The pie chart theme for mermaid's dark diagram page.
 *
 * A fill is chosen for its contrast against the diagram page and for its
 * separation from its neighbours, never from a label, title or hash of a
 * string: the same slice keeps the same colour in every language and every
 * run. Mermaid's own dark theme derives `pie1..pie12` by shifting its primary
 * colour, which lands the first slice — and its legend swatch — near the page
 * colour, so the twelve fills are stated here instead.
 *
 * The section ink is the page colour because the fills are light: the
 * percentage text reads as a cut-out of the slice. The slice stroke is that
 * same colour, so one wedge's outline parts it from the next without drawing a
 * second, unrelated colour into the chart.
 */

/** The dark diagram page: the app's `background` token, and the surface
 * `markdown-palette` composites for a dark diagram. */
const DARK_PIE_SURFACE = '#0E0E10';

export const DARK_PIE_STROKE_COLOR = DARK_PIE_SURFACE;

export const DARK_PIE_SECTION_INK = DARK_PIE_SURFACE;

/**
 * The twelve slice fills, in the order mermaid paints `pie1`..`pie12`. Every
 * one clears WCAG AA text contrast both on the page and on the section ink, so
 * a percentage stays readable on its wedge whatever a diagram's proportions
 * give it. `mermaid-pie-theme.test.ts` measures both pairs.
 */
export const DARK_PIE_FILLS = [
  '#E4AF95',
  '#D8C564',
  '#CAE495',
  '#77D864',
  '#95E4AF',
  '#64D8C5',
  '#95CAE4',
  '#6477D8',
  '#AF95E4',
  '#C564D8',
  '#E495CA',
  '#D86477',
] as const;

/**
 * The `themeVariables` overrides a dark diagram passes to `mermaid.initialize`.
 * A fresh object per call: the caller memoises it, so no two diagrams share one
 * mutable map.
 */
export function darkPieThemeVariables(): Record<string, string> {
  const entries: (readonly [string, string])[] = [
    ['pieSectionTextColor', DARK_PIE_SECTION_INK],
    ['pieOpacity', '1'],
    ['pieStrokeColor', DARK_PIE_STROKE_COLOR],
    ...DARK_PIE_FILLS.map((fill, index) => [`pie${index + 1}`, fill] as const),
  ];
  return Object.fromEntries(entries);
}
