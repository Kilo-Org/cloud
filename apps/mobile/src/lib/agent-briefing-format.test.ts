import { describe, expect, it } from 'vitest';

import {
  BRIEFING_PREVIEW_MAX_GRAPHEMES,
  briefingMoney,
  briefingPreviewExcerpt,
} from './agent-briefing-format';

const FAMILY = '👨‍👩‍👧‍👦';
/** The Devanagari syllable चै: a consonant with its vowel sign, one grapheme. */
const DEVANAGARI_SYLLABLE = 'चै';

function graphemes(value: string): string[] {
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].map(
    part => part.segment
  );
}

describe('briefingMoney', () => {
  it('leads the symbol with two decimals and the active language separators', () => {
    expect(briefingMoney(182_000, 'pt-BR')).toBe('$0,18');
    expect(briefingMoney(122_000, 'pt-BR')).toBe('$0,12');
    expect(briefingMoney(182_000, 'en-US')).toBe('$0.18');
    expect(briefingMoney(182_000, 'de')).toBe('$0,18');
  });

  it('marks an amount below the smallest currency unit instead of rounding it to zero', () => {
    expect(briefingMoney(1800, 'pt-BR')).toBe('< $0,01');
    expect(briefingMoney(1800, 'en-US')).toBe('< $0.01');
  });

  it('keeps a zero amount at the money precision', () => {
    expect(briefingMoney(0, 'pt-BR')).toBe('$0,00');
    expect(briefingMoney(0, 'en-US')).toBe('$0.00');
  });
});

describe('briefingPreviewExcerpt', () => {
  it('keeps a short preview as it is', () => {
    expect(briefingPreviewExcerpt('Overnight work', 'en')).toBe('Overnight work');
  });

  it('collapses whitespace runs and line breaks to single spaces', () => {
    expect(briefingPreviewExcerpt('  Overnight \n\n work\tfinished  ', 'en')).toBe(
      'Overnight work finished'
    );
  });

  it('keeps a preview of exactly the budget unchanged', () => {
    const exact = 'a'.repeat(BRIEFING_PREVIEW_MAX_GRAPHEMES);
    expect(briefingPreviewExcerpt(exact, 'en')).toBe(exact);
    // A hundred user-perceived characters can be far longer in code units.
    const emoji = FAMILY.repeat(BRIEFING_PREVIEW_MAX_GRAPHEMES);
    expect(briefingPreviewExcerpt(emoji, 'en')).toBe(emoji);
  });

  it('cuts a longer preview to one character short of the budget plus an ellipsis', () => {
    const excerpt = briefingPreviewExcerpt('a'.repeat(150), 'en');
    expect(excerpt).toBe(`${'a'.repeat(BRIEFING_PREVIEW_MAX_GRAPHEMES - 1)}…`);
    expect(graphemes(excerpt)).toHaveLength(BRIEFING_PREVIEW_MAX_GRAPHEMES);
  });

  it('never splits a family emoji at the boundary', () => {
    const excerpt = briefingPreviewExcerpt(`${'a'.repeat(98)}${FAMILY}${'b'.repeat(50)}`, 'en');
    expect(excerpt).toBe(`${'a'.repeat(98)}${FAMILY}…`);
    expect(graphemes(excerpt)).toHaveLength(BRIEFING_PREVIEW_MAX_GRAPHEMES);
  });

  it('never splits a Devanagari syllable at the boundary', () => {
    const excerpt = briefingPreviewExcerpt(
      `${'a'.repeat(98)}${DEVANAGARI_SYLLABLE}${'b'.repeat(50)}`,
      'hi'
    );
    expect(excerpt).toBe(`${'a'.repeat(98)}${DEVANAGARI_SYLLABLE}…`);
    expect(graphemes(excerpt)).toHaveLength(BRIEFING_PREVIEW_MAX_GRAPHEMES);
  });

  it('leaves no trailing space before the ellipsis', () => {
    expect(briefingPreviewExcerpt(`${'a'.repeat(98)} ${'b'.repeat(50)}`, 'en')).toBe(
      `${'a'.repeat(98)}…`
    );
  });
});
