import { type ThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  compositeOver,
  type TokenScheme,
  tokenSchemeForSurface,
} from '@/lib/pr-review/diff/syntax-colors';

export type MarkdownVariant = 'assistant' | 'kilo-chat-user' | 'user';

export type MarkdownPalette = {
  textColor: string;
  mutedTextColor: string;
  codeBackground: string;
  borderColor: string;
  // The syntax token scheme for code fences in this variant, derived from the
  // real code-card surface — the bubble tinted by `codeBackground`
  // (`compositeOver`), classified by `tokenSchemeForSurface` — rather than the
  // app color scheme: a dark-theme user bubble is bright lime while a
  // light-theme kilo-chat bubble is dark olive. Optional so hand-written test
  // palettes can omit it and fall back to the app scheme in `CodeBlock`.
  codeTokenScheme?: TokenScheme;
};

// Derive a translucent variant of a theme token so we can tint dividers and
// inline-code backgrounds without introducing new palette entries. Theme
// tokens today are authored as `#RRGGBB` hex strings (see
// `use-theme-colors.ts`); we also keep `hsl(...)` support for forward-compat.
function withAlpha(color: string, alpha: number): string {
  const hslMatch = /^hsl\(\s*([^)]+)\)$/i.exec(color);
  if (hslMatch) {
    return `hsla(${hslMatch[1]}, ${alpha})`;
  }
  const hexMatch = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hexMatch) {
    const [, rHex, gHex, bHex] = hexMatch;
    const r = Number.parseInt(rHex ?? '', 16);
    const g = Number.parseInt(gHex ?? '', 16);
    const b = Number.parseInt(bHex ?? '', 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

export function getPalette(variant: MarkdownVariant, colors: ThemeColors): MarkdownPalette {
  if (variant === 'kilo-chat-user') {
    // kilo-chat user bubbles sit on bg-primary; use primary-foreground ink.
    const ink = colors.primaryForeground;
    const codeBackground = withAlpha(ink, 0.1);
    return {
      textColor: ink,
      mutedTextColor: withAlpha(ink, 0.7),
      codeBackground,
      borderColor: withAlpha(ink, 0.2),
      // Classify the real code card, not the bare bubble: the 10% ink tint is
      // enough to move the card (the light-theme white tint lifts the olive
      // primary #4F5A10 to #616B28, where the `dark` token values must clear
      // 4.5:1 to stay legible).
      codeTokenScheme: tokenSchemeForSurface(compositeOver(codeBackground, colors.primary)),
    };
  }
  if (variant === 'user') {
    // Agent chat user bubbles sit on accent-soft (lime); use ink-on-lime.
    const ink = colors.accentSoftForeground;
    const codeBackground = withAlpha(ink, 0.1);
    return {
      textColor: ink,
      mutedTextColor: withAlpha(ink, 0.7),
      codeBackground,
      borderColor: withAlpha(ink, 0.2),
      codeTokenScheme: tokenSchemeForSurface(compositeOver(codeBackground, colors.accentSoft)),
    };
  }
  return {
    textColor: colors.foreground,
    mutedTextColor: colors.mutedForeground,
    codeBackground: colors.muted,
    borderColor: colors.border,
    codeTokenScheme: tokenSchemeForSurface(colors.muted),
  };
}

export function getMarkdownHeadingStyles(palette: MarkdownPalette) {
  const { textColor } = palette;
  return {
    h1: {
      color: textColor,
      fontSize: 22,
      fontWeight: '700' as const,
      marginTop: 8,
      marginBottom: 4,
    },
    h2: {
      color: textColor,
      fontSize: 20,
      fontWeight: '700' as const,
      marginTop: 8,
      marginBottom: 4,
    },
    h3: {
      color: textColor,
      fontSize: 18,
      fontWeight: '700' as const,
      marginTop: 6,
      marginBottom: 4,
    },
    h4: {
      color: textColor,
      fontSize: 16,
      fontWeight: '700' as const,
      marginTop: 6,
      marginBottom: 4,
    },
    h5: {
      color: textColor,
      fontSize: 15,
      fontWeight: '700' as const,
      marginTop: 4,
      marginBottom: 2,
    },
    h6: {
      color: textColor,
      fontSize: 14,
      fontWeight: '700' as const,
      marginTop: 4,
      marginBottom: 2,
    },
  };
}

export function getMarkdownHtmlTagStyles(palette: MarkdownPalette) {
  const { textColor, borderColor } = palette;
  // `@native-html/css-processor` (react-native-render-html) rejects the logical
  // `borderStartWidth`/`borderStartColor`/`paddingStart` properties with a
  // warning and drops them, so the quote loses its rule entirely. Spell the
  // start edge as the physical left edge instead: React Native mirrors physical
  // left/right padding, margin, and borders under RTL
  // (`doLeftAndRightSwapInRTL` defaults to true), so this rule lands on the
  // right edge of an RTL layout. Choosing the physical side from `isRTL` here
  // would double-mirror it back to the left.
  const blockquoteStart = {
    borderLeftWidth: 3,
    borderLeftColor: borderColor,
    paddingLeft: 12,
  };
  return {
    a: { color: textColor, fontStyle: 'normal' as const, textDecorationLine: 'underline' as const },
    blockquote: {
      ...blockquoteStart,
      marginVertical: 4,
    },
    p: { marginVertical: 2, paddingVertical: 0 },
    strong: { color: textColor, fontWeight: '700' as const },
  };
}
