// Shared runtime palette for diff syntax highlighting. These colors are
// applied as inline `style={{ color }}` values because the token class
// (e.g. 'keyword', 'string') is only known at runtime from the highlighter;
// NativeWind cannot map arbitrary token classes to theme variables at
// build time. Centralizing the palette keeps the two diff renderers
// (unified `DiffLine` and tablet `SideBySideRow`) consistent.

const TOKEN_DARK_LIGHT: Record<string, { light: string; dark: string }> = {
  keyword: { light: '#7B2CBF', dark: '#D8B4FE' },
  builtin: { light: '#1F6FEB', dark: '#79B8FF' },
  literal: { light: '#7B2CBF', dark: '#D8B4FE' },
  number: { light: '#B27214', dark: '#F2B05F' },
  string: { light: '#278150', dark: '#5FCB8E' },
  comment: { light: '#6F6A61', dark: '#8A8680' },
  type: { light: '#1F6FEB', dark: '#79B8FF' },
  function: { light: '#1F6FEB', dark: '#79B8FF' },
  variable: { light: '#14130F', dark: '#F2F0EB' },
  property: { light: '#1F6FEB', dark: '#79B8FF' },
  tag: { light: '#BE4E3F', dark: '#F28B7A' },
  selector: { light: '#7B2CBF', dark: '#D8B4FE' },
  attribute: { light: '#1F6FEB', dark: '#79B8FF' },
  operator: { light: '#6F6A61', dark: '#8A8680' },
  meta: { light: '#6F6A61', dark: '#8A8680' },
  add: { light: '#278150', dark: '#5FCB8E' },
  del: { light: '#BE4E3F', dark: '#F28B7A' },
};

export const DEFAULT_TOKEN_COLOR = { light: '#14130F', dark: '#F2F0EB' };
export const MUTED_COLOR = { light: '#6F6A61', dark: '#8A8680' };

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
