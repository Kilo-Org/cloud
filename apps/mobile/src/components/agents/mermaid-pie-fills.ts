/**
 * The pie chart fills and the `themeVariables` map a diagram paints with.
 *
 * This module imports nothing on purpose: `apps/web`'s TypeScript program reads
 * it (the web app's mermaid page test renders the same page), and
 * `apps/web/tsconfig.json` maps `@/*` to `apps/web/src/*`, so a module with a
 * mobile-only `@/` alias here breaks `typecheck (web)`. The token-bound wrapper
 * that names the diagram page lives in `mermaid-pie-theme.ts`; the ramp and the
 * map itself have this one home, so the page test and the app cannot state two
 * different charts.
 *
 * A fill is chosen for its contrast against the diagram page and for its
 * separation from its neighbours, never from a label, title or hash of a
 * string: the same slice keeps the same colour in every language and every
 * run. Mermaid's own dark theme derives `pie1..pie12` by shifting its primary
 * colour, which lands the first slice — and its legend swatch — near the page
 * colour, so the twelve fills are stated here instead.
 *
 * The twelve hues are the light theme's own, so a series has the same name in
 * both modes: light mode renders mermaid's default palette (measured from the
 * vendored bundle, see `mermaid-pie-theme.test.ts`), and each dark fill keeps
 * that default fill's hue while muting its saturation and lifting its
 * lightness for the dark page. A dark pie chart is therefore the light one with
 * the glare taken out, not a second, starker palette that renames the series.
 */

/**
 * The twelve slice fills, in the order mermaid paints `pie1`..`pie12`.
 *
 * Each is the light default fill's hue, held to a low saturation and an
 * even lightness so no slice pulls the eye away from the chart's content: the
 * whole ramp sits inside a 60–80% HSL lightness band and varies by a dozen
 * points at most. Every one clears WCAG AA text contrast on the page and on the
 * section ink, so a percentage stays readable on its wedge whatever a
 * diagram's proportions give it. `mermaid-pie-theme.test.ts` measures the
 * contrast, the muted band and the hue parity.
 */
export const DARK_PIE_FILLS = [
  '#ADA9D1',
  '#D3D4AF',
  '#AFC195',
  '#848EC2',
  '#CBC49A',
  '#BACCA4',
  '#C8A2C8',
  '#97C0C4',
  '#C99A97',
  '#D4AFD0',
  '#A7CDBB',
  '#C4878B',
] as const;

/**
 * The `themeVariables` overrides a diagram passes to `mermaid.initialize`, with
 * `surface` as the page colour it paints on.
 *
 * The section ink is that page colour because the fills are light: the
 * percentage text reads as a cut-out of the slice. The slice stroke is that
 * same colour, so one wedge's outline parts it from the next without drawing a
 * second, unrelated colour into the chart. A fresh object per call: the caller
 * memoises it, so no two diagrams share one mutable map.
 */
export function pieThemeVariables(surface: string): Record<string, string> {
  const entries: (readonly [string, string])[] = [
    ['pieSectionTextColor', surface],
    ['pieOpacity', '1'],
    ['pieStrokeColor', surface],
    ...DARK_PIE_FILLS.map((fill, index) => [`pie${index + 1}`, fill] as const),
  ];
  return Object.fromEntries(entries);
}
