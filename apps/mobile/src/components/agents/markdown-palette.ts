import { type MarkedStyles } from 'react-native-marked';

import { type ThemeColors } from '@/lib/hooks/use-theme-colors';

export type MarkdownVariant = 'assistant' | 'user';

export type MarkdownPalette = {
  textColor: string;
  mutedTextColor: string;
  codeBackground: string;
  borderColor: string;
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
  if (variant === 'user') {
    // User bubbles sit on `accent-soft` (lime); ink-on-lime is the correct
    // foreground, and translucent ink produces subtle codespan / divider tints.
    const ink = colors.accentSoftForeground;
    return {
      textColor: ink,
      mutedTextColor: withAlpha(ink, 0.7),
      codeBackground: withAlpha(ink, 0.1),
      borderColor: withAlpha(ink, 0.2),
    };
  }
  return {
    textColor: colors.foreground,
    mutedTextColor: colors.mutedForeground,
    codeBackground: colors.muted,
    borderColor: colors.border,
  };
}

// `react-native-marked`'s `useMarkdown` takes an inline styles map rather than
// `className`, so we cannot use NativeWind here. Centralizing style creation
// keeps both variants in sync and makes the color choices reviewable.
export function getMarkdownStyles(palette: MarkdownPalette): MarkedStyles {
  const { textColor, mutedTextColor, codeBackground, borderColor } = palette;

  return {
    text: { color: textColor, fontSize: 16, lineHeight: 24 },
    paragraph: { marginVertical: 2, paddingVertical: 0 },
    strong: { color: textColor, fontWeight: '700' },
    em: { color: textColor, fontStyle: 'italic' },
    link: { color: textColor, fontStyle: 'normal', textDecorationLine: 'underline' },
    h1: { color: textColor, fontSize: 22, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    h2: { color: textColor, fontSize: 20, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    h3: { color: textColor, fontSize: 18, fontWeight: '700', marginTop: 6, marginBottom: 4 },
    h4: { color: textColor, fontSize: 16, fontWeight: '700', marginTop: 6, marginBottom: 4 },
    h5: { color: textColor, fontSize: 15, fontWeight: '700', marginTop: 4, marginBottom: 2 },
    h6: { color: textColor, fontSize: 14, fontWeight: '700', marginTop: 4, marginBottom: 2 },
    // Override the library defaults that set italic + light weight on codespan.
    codespan: {
      color: textColor,
      backgroundColor: codeBackground,
      fontFamily: 'Menlo',
      fontSize: 14,
      fontStyle: 'normal',
      fontWeight: '400',
    },
    code: {
      backgroundColor: codeBackground,
      borderRadius: 8,
      padding: 12,
      marginVertical: 4,
    },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: borderColor,
      paddingLeft: 12,
      marginVertical: 4,
    },
    list: { marginVertical: 2 },
    li: { color: textColor, fontSize: 16, lineHeight: 24 },
    hr: {
      borderBottomWidth: 1,
      borderBottomColor: borderColor,
      marginVertical: 8,
    },
    table: { borderColor, borderWidth: 1, borderRadius: 6, marginVertical: 4 },
    tableRow: { borderColor },
    tableCell: { borderColor },
    strikethrough: { color: mutedTextColor, textDecorationLine: 'line-through' },
  };
}
