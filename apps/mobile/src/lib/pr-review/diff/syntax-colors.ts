// Shared runtime palette for diff syntax highlighting. These colors are
// applied as inline `style={{ color }}` values because the token class
// (e.g. 'keyword', 'string') is only known at runtime from the highlighter;
// NativeWind cannot map arbitrary token classes to theme variables at
// build time. Centralizing the palette keeps the two diff renderers
// (unified `DiffLine` and tablet `SideBySideRow`) consistent.

// The light values are darkened (hue preserved) relative to the Focus FL
// palette so every token holds >= 4.5:1 against the diff tinted surfaces
// (plain background, good-tile, danger-tile). `syntax-colors.test.ts`
// asserts every light value on those composites, so these stay in lockstep
// with `src/global.css`'s `--good` / `--destructive` hue families.
export const TOKEN_DARK_LIGHT: Record<string, { light: string; dark: string }> = {
  keyword: { light: '#7B2CBF', dark: '#D8B4FE' },
  builtin: { light: '#1462DD', dark: '#79B8FF' },
  literal: { light: '#7B2CBF', dark: '#D8B4FE' },
  number: { light: '#925E10', dark: '#F2B05F' },
  string: { light: '#24784A', dark: '#5FCB8E' },
  comment: { light: '#6D6860', dark: '#8A8680' },
  type: { light: '#1462DD', dark: '#79B8FF' },
  function: { light: '#1462DD', dark: '#79B8FF' },
  variable: { light: '#14130F', dark: '#F2F0EB' },
  property: { light: '#1462DD', dark: '#79B8FF' },
  tag: { light: '#B0483A', dark: '#F28B7A' },
  selector: { light: '#7B2CBF', dark: '#D8B4FE' },
  attribute: { light: '#1462DD', dark: '#79B8FF' },
  operator: { light: '#6D6860', dark: '#8A8680' },
  meta: { light: '#6D6860', dark: '#8A8680' },
  add: { light: '#24784A', dark: '#5FCB8E' },
  del: { light: '#B0483A', dark: '#F28B7A' },
};

export const DEFAULT_TOKEN_COLOR = { light: '#14130F', dark: '#F2F0EB' };
export const MUTED_COLOR = { light: '#6D6860', dark: '#8A8680' };

export function tokenColorFor(className: string | null, isDark: boolean): string {
  if (!className) {
    return isDark ? DEFAULT_TOKEN_COLOR.dark : DEFAULT_TOKEN_COLOR.light;
  }
  const palette = TOKEN_DARK_LIGHT[className];
  if (!palette) {
    return isDark ? DEFAULT_TOKEN_COLOR.dark : DEFAULT_TOKEN_COLOR.light;
  }
  return isDark ? palette.dark : palette.light;
}
