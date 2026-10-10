// Shared runtime palette for diff syntax highlighting and markdown code
// fences. These colors are applied as inline `style={{ color }}` values
// because the token class (e.g. 'keyword', 'string') is only known at runtime
// from the highlighter; NativeWind cannot map arbitrary token classes to theme
// variables at build time. Centralizing the palette keeps the two diff
// renderers (unified `DiffLine` and tablet `SideBySideRow`) and the markdown
// code block consistent.
//
// The palette is keyed by the SURFACE the code is painted on, not by the app
// color scheme: a dark-theme user bubble is bright lime (#E8F27A) while a
// light-theme kilo-chat user bubble is dark olive (#4F5A10), so the app scheme
// is the wrong signal for either one. `tokenSchemeForSurface` classifies the
// real code-card background — the bubble tinted by the palette's 10% ink
// (`compositeOver`) — and the matching pair is used: `light` holds dark ink for
// bright cards, `dark` holds light ink for dim cards.
//
// Every `light` value clears 4.5:1 on the light code cards (assistant muted
// #F0EEE6, card #FFFFFF, and the lime user/kilo-chat surfaces including the
// 10%-ink code tint), and every `dark` value clears 4.5:1 on the dark code
// cards (assistant muted #1F1F24, card #17171A, and the light-theme kilo-chat
// code card, where the 10% white ink tint lifts the olive primary #4F5A10 to
// #616B28). Hue is preserved within a token family so the token types stay
// distinguishable. `syntax-colors.test.ts` asserts this, and the light values
// must also keep clearing the tinted diff tiles asserted by
// `src/lib/hooks/use-theme-colors.contrast.test.ts`.
export const TOKEN_DARK_LIGHT = {
  keyword: { light: '#7B2CBF', dark: '#EFE0FF' },
  builtin: { light: '#0F4FB8', dark: '#D2E9FF' },
  literal: { light: '#7B2CBF', dark: '#EFE0FF' },
  number: { light: '#7A4A00', dark: '#FFE1BC' },
  string: { light: '#1E6639', dark: '#C0F2D6' },
  comment: { light: '#57534C', dark: '#EAE6DE' },
  type: { light: '#0F4FB8', dark: '#D2E9FF' },
  function: { light: '#0F4FB8', dark: '#D2E9FF' },
  variable: { light: '#14130F', dark: '#F2F0EB' },
  property: { light: '#0F4FB8', dark: '#D2E9FF' },
  tag: { light: '#8C3527', dark: '#FFDFD2' },
  selector: { light: '#7B2CBF', dark: '#EFE0FF' },
  attribute: { light: '#0F4FB8', dark: '#D2E9FF' },
  operator: { light: '#57534C', dark: '#EAE6DE' },
  meta: { light: '#57534C', dark: '#EAE6DE' },
  add: { light: '#1E6639', dark: '#C0F2D6' },
  del: { light: '#8C3527', dark: '#FFDFD2' },
} satisfies Record<string, { light: string; dark: string }>;

export const DEFAULT_TOKEN_COLOR = { light: '#14130F', dark: '#F2F0EB' };
export const MUTED_COLOR = { light: '#6D6860', dark: '#8A8680' };

/**
 * Which half of `TOKEN_DARK_LIGHT` a surface takes: `onLight` for a bright
 * code card (dark ink), `onDark` for a dim code card (light ink).
 */
export type TokenScheme = 'onLight' | 'onDark';

/**
 * Relative luminance above which a code-card surface is treated as bright.
 * WCAG's own light/dark boundary (0.179) sits lower, but no code card lands
 * between the two supported surfaces (the brightest dim card is the
 * light-theme kilo-chat primary at ~0.09; the dimmest bright card is the
 * lime at ~0.82), so 0.5 keeps the classifier unambiguous.
 */
const LIGHT_SURFACE_LUMINANCE = 0.5;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

/** WCAG 2.x linearised sRGB channel. */
function lineariseChannel(channel: number): number {
  const scaled = channel / 255;
  if (scaled <= 0.039_28) {
    return scaled / 12.92;
  }
  return ((scaled + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG 2.x relative luminance of a `#RGB` / `#RRGGBB` / `#RRGGBBAA` color
 * (0 = black, 1 = white). Returns null when the value is not a parseable hex
 * color (including a missing surface), which the callers treat as bright.
 */
export function relativeLuminance(color: string | undefined): number | null {
  if (!color) {
    return null;
  }
  const value = color.startsWith('#') ? color.slice(1) : color;
  const hex = (value.length === 8 ? value.slice(0, 6) : value).replace(
    /^([0-9a-f])([0-9a-f])([0-9a-f])$/i,
    '$1$1$2$2$3$3'
  );
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return null;
  }
  const red = lineariseChannel(Number.parseInt(hex.slice(0, 2), 16));
  const green = lineariseChannel(Number.parseInt(hex.slice(2, 4), 16));
  const blue = lineariseChannel(Number.parseInt(hex.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Composites a possibly-translucent color (`#RRGGBBAA` or `rgba(...)`) over an
 * opaque background and returns the resulting `#RRGGBB`. The code card is the
 * markdown palette's 10% ink tint, so this is the surface the syntax tokens
 * actually render on — the untinted bubble is not. Returns the input unchanged
 * when either color cannot be parsed.
 */
export function compositeOver(color: string, background: string): string {
  const foreground = parseColor(color);
  const base = parseColor(background);
  if (!foreground || !base) {
    return color;
  }
  const channels = [foreground.r, foreground.g, foreground.b].map((channel, index) => {
    const baseChannel = [base.r, base.g, base.b][index] ?? 0;
    return Math.round(channel * foreground.alpha + baseChannel * (1 - foreground.alpha));
  });
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

type ParsedColor = { r: number; g: number; b: number; alpha: number };

/** Parses a `#RRGGBB` / `#RRGGBBAA` / `rgb(...)` / `rgba(...)` color. */
function parseColor(color: string): ParsedColor | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(color.trim());
  if (hex) {
    const [, rHex, gHex, bHex, aHex] = hex;
    return {
      r: Number.parseInt(rHex ?? '00', 16),
      g: Number.parseInt(gHex ?? '00', 16),
      b: Number.parseInt(bHex ?? '00', 16),
      alpha: aHex ? Number.parseInt(aHex, 16) / 255 : 1,
    };
  }
  const fn =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)$/i.exec(
      color.trim()
    );
  if (fn) {
    const [, r, g, b, a] = fn;
    return {
      r: Number.parseInt(r ?? '0', 10),
      g: Number.parseInt(g ?? '0', 10),
      b: Number.parseInt(b ?? '0', 10),
      alpha: a ? Number.parseFloat(a) : 1,
    };
  }
  return null;
}

/**
 * Classifies a code-card surface color into the token scheme that stays
 * legible on it. The markdown palettes pass the real card background
 * (assistant `codeBackground`, the composite of the kilo-chat/user bubble
 * tint), so a bright bubble never gets light ink and a dark bubble never gets
 * dark ink.
 */
export function tokenSchemeForSurface(surfaceColor: string | undefined): TokenScheme {
  const luminance = relativeLuminance(surfaceColor);
  if (luminance !== null && luminance <= LIGHT_SURFACE_LUMINANCE) {
    return 'onDark';
  }
  return 'onLight';
}

/** Looks up a token color for an explicit surface scheme. */
export function tokenColorForScheme(className: string | null, scheme: TokenScheme): string {
  const fallback = scheme === 'onLight' ? DEFAULT_TOKEN_COLOR.light : DEFAULT_TOKEN_COLOR.dark;
  if (!className) {
    return fallback;
  }
  const palette = lookup(TOKEN_DARK_LIGHT, className);
  if (!palette) {
    return fallback;
  }
  return scheme === 'onLight' ? palette.light : palette.dark;
}

/**
 * Boolean form kept for the diff renderers, whose tinted rows follow the app
 * color scheme. Markdown code cards use `tokenColorForScheme` with the scheme
 * derived from their own surface instead.
 */
export function tokenColorFor(className: string | null, isDark: boolean): string {
  return tokenColorForScheme(className, isDark ? 'onDark' : 'onLight');
}
