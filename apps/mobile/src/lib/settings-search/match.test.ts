import { describe, expect, it } from 'vitest';

import { searchSettings, type SettingsSearchText } from './match';

function matchedLabels(
  entries: readonly SettingsSearchText[],
  query: string,
  locale = 'en'
): string[] {
  return searchSettings(entries, query, locale).map(result => result.entry.label);
}

describe('searchSettings', () => {
  describe('case and offsets', () => {
    it('reports UTF-16 offsets into the original label', () => {
      const [result] = searchSettings([{ label: 'Theme' }], 'the', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 3 }]);

      const [middle] = searchSettings([{ label: 'Theme' }], 'eme', 'en');
      expect(middle?.ranges).toEqual([{ start: 2, end: 5 }]);
    });

    it('highlights every occurrence in the label', () => {
      const [result] = searchSettings([{ label: 'Theme' }], 'e', 'en');
      expect(result?.ranges).toEqual([
        { start: 2, end: 3 },
        { start: 4, end: 5 },
      ]);
    });

    it('folds case without shifting the original offsets', () => {
      const [result] = searchSettings([{ label: 'Theme' }], 'THEME', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 5 }]);
    });

    it('keeps astral characters outside a following label match', () => {
      const [result] = searchSettings([{ label: '😀 Theme' }], 'theme', 'en');
      expect(result?.ranges).toEqual([{ start: 3, end: 8 }]);
    });
  });

  describe('diacritics and decomposition', () => {
    it('matches a label written without its diacritics', () => {
      const [result] = searchSettings([{ label: 'Español' }], 'espanol', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 7 }]);
    });

    it('includes a decomposed combining mark in the match', () => {
      const [result] = searchSettings([{ label: 'Cafe\u0301' }], 'cafe', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 5 }]);
    });

    it('keeps a precomposed letter inside its own code unit', () => {
      const [result] = searchSettings([{ label: 'Café' }], 'cafe', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 4 }]);
    });

    it('maps a decomposed query onto a precomposed label', () => {
      const [result] = searchSettings([{ label: 'Café' }], 'Cafe\u0301', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 4 }]);
    });

    it('keeps offsets after a decomposed mark', () => {
      const [result] = searchSettings([{ label: 'Cafe\u0301 Noir' }], 'noir', 'en');
      expect(result?.ranges).toEqual([{ start: 6, end: 10 }]);
    });

    it('keeps kana voicing marks that are letters, not accents', () => {
      expect(matchedLabels([{ label: 'がっこう' }], 'かっこう', 'ja')).toEqual([]);
      expect(matchedLabels([{ label: 'がっこう' }], 'がっこう', 'ja')).toEqual(['がっこう']);
    });

    it('folds the German sharp s to ss', () => {
      const [result] = searchSettings([{ label: 'Größe' }], 'grosse', 'de');
      expect(result?.ranges).toEqual([{ start: 0, end: 5 }]);
    });

    it('strips Arabic vowel marks', () => {
      const label = 'مَرْحَبًا';
      const [result] = searchSettings([{ label }], 'مرحبا', 'ar');
      expect(result?.ranges).toEqual([{ start: 0, end: label.length }]);
    });

    it('strips Hebrew points', () => {
      const label = 'שָׁלוֹם';
      const [result] = searchSettings([{ label }], 'שלום', 'he');
      expect(result?.ranges).toEqual([{ start: 0, end: label.length }]);
    });

    it('keeps Indic vowel signs that change the syllable', () => {
      expect(matchedLabels([{ label: 'कि' }], 'कि', 'hi')).toEqual(['कि']);
      expect(matchedLabels([{ label: 'कि' }], 'कु', 'hi')).toEqual([]);
    });
  });

  describe('Turkish and Azerbaijani casing', () => {
    it('matches İ with i and I with ı', () => {
      expect(matchedLabels([{ label: 'İndir' }], 'indir', 'tr')).toEqual(['İndir']);
      expect(matchedLabels([{ label: 'I' }], 'ı', 'tr')).toEqual(['I']);
    });

    it('keeps dotted and dotless i distinct', () => {
      expect(matchedLabels([{ label: 'I' }], 'i', 'tr')).toEqual([]);
      expect(matchedLabels([{ label: 'Indir' }], 'indir', 'tr')).toEqual([]);
    });

    it('folds an uppercase Turkish query the same way as the label', () => {
      expect(matchedLabels([{ label: 'Işık' }], 'IŞIK', 'tr')).toEqual(['Işık']);
    });

    it('matches canonically equivalent decomposed input', () => {
      const [result] = searchSettings([{ label: '\u0130ndir' }], 'I\u0307ndir', 'tr');
      expect(result?.ranges).toEqual([{ start: 0, end: 5 }]);
    });

    it('applies the Turkic rule to Azerbaijani too', () => {
      expect(matchedLabels([{ label: 'İndir' }], 'indir', 'az')).toEqual(['İndir']);
      expect(matchedLabels([{ label: 'Indir' }], 'indir', 'az')).toEqual([]);
    });
  });

  describe('Greek', () => {
    it('strips tonos and folds case', () => {
      const [result] = searchSettings([{ label: 'Ρυθμίσεις' }], 'ρυθμισεις', 'el');
      expect(result?.ranges).toEqual([{ start: 0, end: 9 }]);
    });

    it('treats final sigma as sigma', () => {
      const [result] = searchSettings([{ label: 'Οδός' }], 'οδοσ', 'el');
      expect(result?.ranges).toEqual([{ start: 0, end: 4 }]);
    });
  });

  describe('Serbian, Croatian and Bosnian', () => {
    it('matches đ with dj in the sh languages', () => {
      for (const locale of ['sr', 'hr', 'bs']) {
        expect(matchedLabels([{ label: 'Đorđe' }], 'djordje', locale)).toEqual(['Đorđe']);
      }
    });

    it('does not invent the đ/dj digraph outside those languages', () => {
      expect(matchedLabels([{ label: 'Đorđe' }], 'djordje', 'en')).toEqual([]);
    });

    it('folds đ to d where it is a plain letter', () => {
      const [result] = searchSettings([{ label: 'Đường' }], 'duong', 'vi');
      expect(result?.ranges).toEqual([{ start: 0, end: 5 }]);
    });

    it('matches Serbian Cyrillic input against Latin catalog labels', () => {
      const [result] = searchSettings([{ label: 'Podešavanja' }], 'подешавања', 'sr');
      expect(result?.ranges).toEqual([{ start: 0, end: 11 }]);
      expect(matchedLabels([{ label: 'đak' }], 'ђак', 'sr')).toEqual(['đak']);
    });

    it('reports the whole grapheme for each folded unit of an expanded scalar', () => {
      for (const query of ['d', 'j']) {
        const [result] = searchSettings([{ label: 'đ\u0301x' }], query, 'sr');
        expect(result?.ranges).toEqual([{ start: 0, end: 2 }]);
      }
    });

    it('matches Latin input against a Serbian Cyrillic label', () => {
      const [result] = searchSettings([{ label: 'Подешавања' }], 'podesavanja', 'sr');
      expect(result?.ranges).toEqual([{ start: 0, end: 10 }]);
    });

    it('does not transliterate Serbian Cyrillic in another language', () => {
      expect(matchedLabels([{ label: 'Podešavanja' }], 'подешавања', 'hr')).toEqual([]);
    });
  });

  describe('fields and ranking', () => {
    it('returns a keyword-only match without label ranges', () => {
      const entry = { label: 'Sign out', keywords: ['logout', 'log off'] };
      const [result] = searchSettings([entry], 'logout', 'en');
      expect(result?.entry).toBe(entry);
      expect(result?.ranges).toEqual([]);
    });

    it('returns a context-only match without label ranges', () => {
      const entry = { label: 'Dark mode', context: 'Appearance' };
      const [result] = searchSettings([entry], 'appearance', 'en');
      expect(result?.entry).toBe(entry);
      expect(result?.ranges).toEqual([]);
    });

    it('requires every query word and allows words in different fields', () => {
      const entries = [{ label: 'Theme', keywords: ['dark'] }];
      expect(matchedLabels(entries, 'dark theme')).toEqual(['Theme']);
      expect(matchedLabels(entries, 'dark volume')).toEqual([]);

      const [result] = searchSettings(entries, 'dark theme', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 5 }]);
    });

    it('searches translated labels and translated keywords', () => {
      const entries = [{ label: 'Darstellung', keywords: ['Design', 'Farbschema'] }];
      expect(matchedLabels(entries, 'farbschema', 'de')).toEqual(['Darstellung']);
      expect(matchedLabels(entries, 'darstellung', 'de')).toEqual(['Darstellung']);
    });

    it('ranks label matches above context and keyword matches, stable within a tier', () => {
      const entries: SettingsSearchText[] = [
        { label: 'Sign out', keywords: ['theme'] },
        { label: 'Theme' },
        { label: 'Appearance', keywords: ['theme'] },
      ];
      expect(matchedLabels(entries, 'theme')).toEqual(['Theme', 'Sign out', 'Appearance']);
    });
  });

  describe('ranges and queries', () => {
    it('highlights repeated words once per occurrence', () => {
      const [result] = searchSettings([{ label: 'Theme theme' }], 'theme theme', 'en');
      expect(result?.ranges).toEqual([
        { start: 0, end: 5 },
        { start: 6, end: 11 },
      ]);
    });

    it('merges overlapping label matches into one range', () => {
      const [result] = searchSettings([{ label: 'aaaa' }], 'aa aa', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 4 }]);
    });

    it('finds overlapping occurrences of a repeated word', () => {
      const [result] = searchSettings([{ label: 'aaa' }], 'aa', 'en');
      expect(result?.ranges).toEqual([{ start: 0, end: 3 }]);
    });

    it('returns no results for an unmatched or empty query', () => {
      expect(searchSettings([{ label: 'Theme' }], 'volume', 'en')).toEqual([]);
      expect(searchSettings([{ label: 'Theme' }], '', 'en')).toEqual([]);
      expect(searchSettings([{ label: 'Theme' }], '   ', 'en')).toEqual([]);
    });
  });
});
