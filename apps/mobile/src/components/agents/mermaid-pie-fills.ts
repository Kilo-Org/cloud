/**
 * The pie chart fills and the `themeVariables` map a diagram paints with.
 *
 * This module imports nothing on purpose: `apps/web`'s TypeScript program reads
 * it (the web app's mermaid page test renders the same page), and
 * `apps/web/tsconfig.json` maps `@/*` to `apps/web/src/*`, so a module with a
 * mobile-only `@/` alias here breaks `typecheck (web)`. The token-bound wrappers
 * that name the diagram pages live in `mermaid-pie-theme.ts`; the ramps and the
 * map itself have this one home, so the page test and the app cannot state two
 * different charts.
 *
 * A fill is chosen for its contrast against the diagram page and for its
 * separation from its neighbours, never from a label, title or hash of a
 * string: the same slice keeps the same colour in every language and every
 * run. Mermaid's own themes derive `pie1..pie12` by shifting their primary
 * colour, which lands the first slice — and its legend swatch — near the page
 * colour, so each page states its own twelve fills here instead.
 *
 * Both ramps keep the default palette's hues and differ in lightness and
 * saturation only, each measured against the page it paints on: a series keeps
 * the same hue family in both modes, so a slice a reader knows as red in light
 * mode is the same muted red on the dark page. Neither ramp is a second,
 * starker palette that renames the series.
 */

/**
 * The twelve slice fills for the light diagram page, in the order mermaid paints
 * `pie1`..`pie12`.
 *
 * The default palette is pastel and fades into the cream page, so the light page
 * states its own fills rather than repainting mermaid's. Each keeps the hue of
 * the default fill at its index (within 15.65°) and takes one lightness band at
 * a low saturation: HSL lightness 27.6%–40.2%, a 12.5 point spread, saturation
 * at most 0.480. Contrast against the light diagram page `#FBFAF5` runs 4.83:1
 * to 10.30:1, so every fill clears the 4.5:1 WCAG AA text bar even where a
 * slice is thin or the page behind it shows through its legend swatch.
 *
 * Distance on the ramp, not lightness alone, is what keeps the wedges apart.
 * Mermaid paints these in slice order, so a pie with fewer than twelve slices
 * drops the tail: a six-slice chart paints `pie1..pie6`, which repeats the
 * lavender, yellow and yellow-green families. Each of those twins therefore
 * takes a different part of the lightness band, and every pair of the twelve —
 * not just the twins — sits at least 17.57 CIE76 ΔE apart, so no two wedges or
 * their legend swatches read as one colour. `mermaid-pie-theme.test.ts` measures
 * that pairwise distance, the contrast, the band and the hue parity.
 *
 * The ink and the stroke are the page colour, as on the dark page, so a single
 * contrast rule serves the wedges, the legend swatches and the percentage text:
 * the page-coloured text reads as a cut-out of each darker slice.
 */
export const LIGHT_PIE_FILLS = [
  '#475484',
  '#645836',
  '#4F7A30',
  '#39368D',
  '#6E7128',
  '#445F31',
  '#702E83',
  '#327687',
  '#5C3138',
  '#7F4471',
  '#2B785D',
  '#8D4640',
] as const;

/**
 * The twelve slice fills, in the order mermaid paints `pie1`..`pie12`.
 *
 * Each is the default fill's hue, held to a low saturation and one 60–80% HSL
 * lightness band. Every one clears WCAG AA text contrast on the page and on the
 * section ink, so a percentage stays readable on its wedge whatever a diagram's
 * proportions give it.
 *
 * Distance on the ramp, not lightness alone, is what keeps the wedges apart.
 * Mermaid paints these in slice order, so a pie with fewer than twelve slices
 * drops the tail: a six-slice chart paints `pie1..pie6`, which repeats the
 * lavender, yellow and yellow-green families. Each of those twins therefore
 * takes a different part of the lightness band, and every pair of the twelve —
 * not just the twins — sits at least 16 CIE76 ΔE apart, so no two wedges or
 * their legend swatches read as one colour. `mermaid-pie-theme.test.ts` measures
 * that pairwise distance, the contrast, the muted band and the hue parity.
 */
export const DARK_PIE_FILLS = [
  '#828DB7',
  '#CCC5AF',
  '#95BC78',
  '#8579BB',
  '#BFBA7B',
  '#9DB189',
  '#B47BBF',
  '#A3CBD2',
  '#B29690',
  '#B992BB',
  '#83B9A8',
  '#BD787D',
] as const;

/**
 * The `themeVariables` overrides a diagram passes to `mermaid.initialize`, with
 * `fills` as the ramp of the page it paints and `surface` as that page's colour.
 *
 * The section ink is the page colour because the ramp is chosen to contrast with
 * it: on the dark page the percentage reads as a cut-out of a light slice, and on
 * the light page as a cut-out of a dark one, so the same rule serves both. The
 * slice stroke is that same colour, so one wedge's outline parts it from the next
 * without drawing a second, unrelated colour into the chart. A fresh object per
 * call: the caller memoises it, so no two diagrams share one mutable map.
 */
export function pieThemeVariables(
  fills: readonly string[],
  surface: string
): Record<string, string> {
  const entries: (readonly [string, string])[] = [
    ['pieSectionTextColor', surface],
    ['pieOpacity', '1'],
    ['pieStrokeColor', surface],
    ...fills.map((fill, index) => [`pie${index + 1}`, fill] as const),
  ];
  return Object.fromEntries(entries);
}
