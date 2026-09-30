import { describe, expect, it, vi } from 'vitest';

import {
  compositeOver,
  DEFAULT_TOKEN_COLOR,
  relativeLuminance,
  TOKEN_DARK_LIGHT,
  tokenColorFor,
  tokenColorForScheme,
  tokenSchemeForSurface,
} from './syntax-colors';

vi.mock('react-native', () => ({ useColorScheme: () => 'light' }));
vi.mock('expo-router', () => ({ DarkTheme: {}, DefaultTheme: {} }));

// The WCAG contrast assertions for the tinted diff tiles live in
// `src/lib/hooks/use-theme-colors.contrast.test.ts`, next to the palette they
// are painted on. The assertions here cover the markdown code cards, whose
// scheme is derived from the card surface rather than the app color scheme.

const MIN_TEXT_RATIO = 4.5;

// The code card is a translucent tint over the bubble, so the text renders on
// the composite, not the bare bubble. Mirrors how the palette paints it.
const KILO_CHAT_LIGHT_CODE_TINT = 'rgba(255, 255, 255, 0.1)';
const KILO_CHAT_LIGHT_CARD = compositeOver(KILO_CHAT_LIGHT_CODE_TINT, '#4F5A10');
const LIME_CODE_TINT = 'rgba(26, 26, 16, 0.1)';
const LIME_CARD = compositeOver(LIME_CODE_TINT, '#E8F27A');

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) {
    throw new Error('contrastRatio needs two parseable hex colors');
  }
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('tokenColorFor', () => {
  it('returns the light color for a known class in light mode', () => {
    expect(tokenColorFor('keyword', false)).toBe('#7B2CBF');
  });

  it('returns the dark color for a known class in dark mode', () => {
    expect(tokenColorFor('keyword', true)).toBe('#EFE0FF');
  });

  it('falls back to the default color for an unknown class', () => {
    expect(tokenColorFor('unknown-token', false)).toBe(DEFAULT_TOKEN_COLOR.light);
    expect(tokenColorFor('unknown-token', true)).toBe(DEFAULT_TOKEN_COLOR.dark);
  });

  it('falls back to the default color when className is null', () => {
    expect(tokenColorFor(null, false)).toBe(DEFAULT_TOKEN_COLOR.light);
    expect(tokenColorFor(null, true)).toBe(DEFAULT_TOKEN_COLOR.dark);
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBe(1);
  });

  it('expands shorthand hex and ignores an alpha suffix', () => {
    expect(relativeLuminance('#FFF')).toBe(1);
    expect(relativeLuminance('#00000080')).toBe(0);
  });

  it('returns null for a color it cannot parse', () => {
    expect(relativeLuminance('rgba(0, 0, 0, 0.5)')).toBeNull();
    expect(relativeLuminance('transparent')).toBeNull();
  });
});

describe('compositeOver', () => {
  it('blends a translucent rgba() tint over an opaque hex card', () => {
    expect(compositeOver('rgba(255, 255, 255, 0.1)', '#4F5A10')).toBe('#616b28');
  });

  it('blends an 8-digit hex tint and returns opaque hex', () => {
    expect(compositeOver('#1A1A101a', '#E8F27A')).toBe('#d3dc6f');
  });

  it('returns an opaque color unchanged and passes through unparseable input', () => {
    expect(compositeOver('#F0EEE6', '#FFFFFF')).toBe('#f0eee6');
    expect(compositeOver('transparent', '#FFFFFF')).toBe('transparent');
  });
});

describe('tokenSchemeForSurface', () => {
  it('treats the bright lime user and kilo-chat card as onLight', () => {
    expect(tokenSchemeForSurface('#E8F27A')).toBe('onLight');
  });

  it('treats the light theme kilo-chat olive card as onDark', () => {
    expect(tokenSchemeForSurface('#4F5A10')).toBe('onDark');
    // The palette feeds the composited card (10% white tint lifts the olive to
    // #616B28), which must classify the same way the bare primary does.
    expect(tokenSchemeForSurface(KILO_CHAT_LIGHT_CARD)).toBe('onDark');
  });

  it('follows the assistant code card in each theme', () => {
    expect(tokenSchemeForSurface('#F0EEE6')).toBe('onLight');
    expect(tokenSchemeForSurface('#1F1F24')).toBe('onDark');
  });

  it('treats the card token in each theme correctly', () => {
    expect(tokenSchemeForSurface('#FFFFFF')).toBe('onLight');
    expect(tokenSchemeForSurface('#17171A')).toBe('onDark');
  });

  it('treats an unparseable surface as bright', () => {
    expect(tokenSchemeForSurface('rgba(255, 255, 255, 0.1)')).toBe('onLight');
    expect(tokenSchemeForSurface(undefined)).toBe('onLight');
  });
});

describe('tokenColorForScheme', () => {
  it('selects the dark-ink pair for onLight', () => {
    expect(tokenColorForScheme('keyword', 'onLight')).toBe(TOKEN_DARK_LIGHT.keyword.light);
    expect(tokenColorForScheme(null, 'onLight')).toBe(DEFAULT_TOKEN_COLOR.light);
    expect(tokenColorForScheme('unknown-token', 'onLight')).toBe(DEFAULT_TOKEN_COLOR.light);
  });

  it('selects the light-ink pair for onDark', () => {
    expect(tokenColorForScheme('string', 'onDark')).toBe(TOKEN_DARK_LIGHT.string.dark);
    expect(tokenColorForScheme(null, 'onDark')).toBe(DEFAULT_TOKEN_COLOR.dark);
    expect(tokenColorForScheme('unknown-token', 'onDark')).toBe(DEFAULT_TOKEN_COLOR.dark);
  });
});

describe('syntax tokens on their code-card surfaces (WCAG AA text)', () => {
  const lightTokens: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(TOKEN_DARK_LIGHT).map(([name, pair]) => [name, pair.light])
    ),
    default: DEFAULT_TOKEN_COLOR.light,
  };
  const darkTokens: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(TOKEN_DARK_LIGHT).map(([name, pair]) => [name, pair.dark])
    ),
    default: DEFAULT_TOKEN_COLOR.dark,
  };

  // Bright code cards: the assistant `muted` card, the app card, and the lime
  // user/kilo-chat bubble — plus the 10% dark-ink code tint the bubble paints.
  const brightCards = {
    assistant: '#F0EEE6',
    card: '#FFFFFF',
    lime: '#E8F27A',
    limeTint: LIME_CARD,
  } as const;

  // Dim code cards: the dark-theme assistant `muted` and `card`, and the
  // light-theme kilo-chat code card (the olive primary lifted by the 10% white
  // ink tint). The tokens land on the composite, not the bare primary.
  const dimCards = {
    assistant: '#1F1F24',
    card: '#17171A',
    kiloChatOliveCard: KILO_CHAT_LIGHT_CARD,
  } as const;

  it('every onLight token clears 4.5:1 on each bright card', () => {
    for (const [token, color] of Object.entries(lightTokens)) {
      for (const [surfaceName, surface] of Object.entries(brightCards)) {
        const ratio = contrastRatio(color, surface);
        expect(ratio, `${token} (${color}) vs ${surfaceName}`).toBeGreaterThanOrEqual(
          MIN_TEXT_RATIO
        );
      }
    }
  });

  it('every onDark token clears 4.5:1 on each dim card, including the tinted olive card', () => {
    for (const [token, color] of Object.entries(darkTokens)) {
      for (const [surfaceName, surface] of Object.entries(dimCards)) {
        const ratio = contrastRatio(color, surface);
        expect(ratio, `${token} (${color}) vs ${surfaceName}`).toBeGreaterThanOrEqual(
          MIN_TEXT_RATIO
        );
      }
    }
  });

  it('keeps the token families visually distinct within each scheme', () => {
    expect(new Set(Object.values(lightTokens)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(Object.values(darkTokens)).size).toBeGreaterThanOrEqual(6);
    expect(TOKEN_DARK_LIGHT.keyword.light).not.toBe(TOKEN_DARK_LIGHT.string.light);
    expect(TOKEN_DARK_LIGHT.string.light).not.toBe(TOKEN_DARK_LIGHT.tag.light);
    expect(TOKEN_DARK_LIGHT.keyword.dark).not.toBe(TOKEN_DARK_LIGHT.string.dark);
    expect(TOKEN_DARK_LIGHT.string.dark).not.toBe(TOKEN_DARK_LIGHT.tag.dark);
    expect(TOKEN_DARK_LIGHT.comment.dark).not.toBe(TOKEN_DARK_LIGHT.variable.dark);
  });
});
