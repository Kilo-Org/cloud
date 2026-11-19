import { describe, expect, it } from 'vitest';

import { getPalette } from './markdown-palette';
import { type ThemeColors } from '@/lib/hooks/use-theme-colors';
import { compositeOver, tokenSchemeForSurface } from '@/lib/pr-review/diff/syntax-colors';

const colors = {
  background: '#FBFAF5',
  foreground: '#14130F',
  primary: '#4F5A10',
  primaryForeground: '#FFFFFF',
  primaryDisabled: '#6F6A61',
  primaryDisabledAction: '#6F6A61',
  secondary: '#F0EEE6',
  secondaryForeground: '#14130F',
  secondaryFill: '#F0EEE6',
  muted: '#F0EEE6',
  mutedForeground: '#7A756B',
  destructive: '#C25647',
  destructiveForeground: '#FFFFFF',
  destructiveSolid: '#C25647',
  destructiveSolidForeground: '#FFFFFF',
  border: 'rgba(20, 15, 10, 0.09)',
  card: '#FFFFFF',
  selection: '#4F5A10',
  selectionForeground: '#FFFFFF',
  ink2: '#3C382F',
  mutedSoft: '#A9A39A',
  hairSoft: 'rgba(20, 15, 10, 0.05)',
  controlIdle: '#F0EEE6',
  skeletonFill: '#F0EEE6',
  ringTrack: 'rgba(20, 15, 10, 0.05)',
  accentSoft: '#FFDD00',
  accentSoftForeground: '#1A1A10',
  accentSoftTint: '#4F5A1029',
  accentSoftTintForeground: '#4F5A10',
  good: '#2F9A5F',
  warn: '#B27214',
  warnForeground: '#FFFFFF',
  info: '#2563EB',
  agentYuki: '#6B4FD6',
  agentWorkclaw: '#4F5A10',
  agentCloud: '#2F9A5F',
  agentKilocode: '#B27214',
  agentCoral: '#C25647',
  agentSky: '#2C7FB0',
  rowHoney: '#7C6C1D',
  rowGold: '#7A7C1D',
  rowLime: '#697C1D',
  rowSage: '#587C1D',
  rowMoss: '#467C1D',
  rowFern: '#357C1D',
  rowPine: '#237C1D',
} satisfies ThemeColors;

describe('markdown palette', () => {
  it('uses accent-soft-foreground for agent chat user bubbles (bg-accent-soft)', () => {
    const palette = getPalette('user', colors);

    expect(palette.textColor).toBe(colors.accentSoftForeground);
  });

  it('composites the user code card onto the bubble to an opaque surface', () => {
    const palette = getPalette('user', colors);

    // rgba(26,26,16,0.1) over #FFDD00 = #e8ca02; the diagram page paints this,
    // so it must not carry alpha.
    expect(palette.codeSurface).toBe('#e8ca02');
    expect(palette.codeSurface.startsWith('#') && palette.codeSurface.length === 7).toBe(true);
  });

  it('keeps the assistant code card as its own opaque surface', () => {
    const palette = getPalette('assistant', colors);

    // The muted token is opaque, so the composite is the token itself (case
    // normalized by the parser); the composite keeps it opaque even if the
    // token ever becomes translucent.
    expect(palette.codeSurface).toBe('#f0eee6');
    expect(palette.codeSurface.startsWith('#') && palette.codeSurface.length === 7).toBe(true);
  });

  it('derives the assistant code token scheme from the composited code surface', () => {
    const palette = getPalette('assistant', colors);

    // The scheme classifies the surface the code card actually renders on:
    // muted composited over card, not card on its own.
    expect(palette.codeSurface).toBe(compositeOver(colors.muted, colors.card));
    expect(palette.codeTokenScheme).toBe(tokenSchemeForSurface(palette.codeSurface));
    expect(palette.codeTokenScheme).toBe('onLight');
  });

  it('keeps a translucent assistant code card on the dark token scheme', () => {
    const darkCard: ThemeColors = { ...colors, muted: 'rgba(255,255,255,0.08)', card: '#14130f' };
    const palette = getPalette('assistant', darkCard);

    // The raw token is translucent, so only the composite is a paintable
    // surface; it stays opaque and dark.
    const expectedSurface = compositeOver(darkCard.muted, darkCard.card);
    expect(palette.codeSurface).toBe(expectedSurface);
    expect(palette.codeSurface).toBe('#272622');
    expect(palette.codeSurface.startsWith('#') && palette.codeSurface.length === 7).toBe(true);
    expect(palette.codeTokenScheme).toBe(tokenSchemeForSurface(expectedSurface));
    expect(palette.codeTokenScheme).toBe('onDark');
  });

  it('classifies the composite rather than the card behind it', () => {
    const tintedCard: ThemeColors = {
      ...colors,
      muted: 'rgba(20,19,15,0.92)',
      card: '#FFFFFF',
    };
    const palette = getPalette('assistant', tintedCard);

    // A bright card under a heavy translucent tint composites to the same dim
    // surface, so a scheme derived from `colors.card` would be wrong here.
    expect(tokenSchemeForSurface(tintedCard.card)).toBe('onLight');
    expect(palette.codeSurface).toBe(compositeOver(tintedCard.muted, tintedCard.card));
    expect(palette.codeTokenScheme).toBe('onDark');
  });
});
