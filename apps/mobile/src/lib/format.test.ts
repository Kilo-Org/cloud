import { describe, expect, it } from 'vitest';

import { SUPPORTED_LANGUAGES } from '@/i18n/languages';

import {
  firstGrapheme,
  formatCalendarDate,
  formatFileSize,
  formatList,
  formatMoney,
  formatNumber,
  normalizeLocalizedNumber,
  parseLocalizedNumber,
} from './format';

describe('formatMoney', () => {
  it('uses the passed locale for currency formatting', () => {
    const en = formatMoney(1234.5, 'en-US');
    const de = formatMoney(1234.5, 'de-DE');

    expect(en).toBe('$1,234.50');
    expect(de).toContain('1.234,50');
    expect(de).toMatch(/1\.234,50\s\$$/);
    expect(formatMoney(1234.5, 'ar')).not.toContain('US$');
    expect(de).not.toBe(en);
  });

  it('uses Portugal rules for Portuguese and Brazil rules for Brazilian Portuguese', () => {
    expect(formatMoney(1234.5, 'pt')).toMatch(/^1234,50[\s\u00A0\u202F]+\$$/);
    expect(formatMoney(1234.5, 'pt-BR')).toMatch(/^\$[\s\u00A0\u202F]*1\.234,50$/);
  });
});

describe('localized format helpers', () => {
  it('formats a list and preserves one grapheme', () => {
    expect(formatList(['A', 'B'], 'de')).toBe('A und B');
    expect(formatFileSize(1024, 'de')).toContain('1 kB');
    expect(firstGrapheme('👨‍👩‍👧‍👦 family', 'en')).toBe('👨‍👩‍👧‍👦');
  });

  it('parses localized numbers and rejects other input', () => {
    expect(parseLocalizedNumber('1.234,5', 'de-DE')).toBe(1234.5);
    expect(parseLocalizedNumber('1 234,5', 'ru')).toBe(1234.5);
    expect(parseLocalizedNumber('twelve', 'en')).toBeNull();
  });

  it('parses the digits a native-script keypad types in any locale', () => {
    expect(parseLocalizedNumber('٢٥', 'ar')).toBe(25);
    expect(parseLocalizedNumber('۲۵', 'ar')).toBe(25);
    expect(parseLocalizedNumber('२५', 'hi')).toBe(25);
    expect(parseLocalizedNumber('২৫', 'bn')).toBe(25);
    expect(parseLocalizedNumber('၂၅', 'my')).toBe(25);
  });

  it('parses ASCII digits typed in a locale that formats with its own digits', () => {
    expect(parseLocalizedNumber('25', 'ar-EG')).toBe(25);
    expect(parseLocalizedNumber('٢٥', 'ar-EG')).toBe(25);
  });

  it('keeps the locale separators around folded digits', () => {
    expect(parseLocalizedNumber('١٬٢٣٤٫٥', 'ar-EG')).toBe(1234.5);
    expect(parseLocalizedNumber('1,234.5', 'ar')).toBe(1234.5);
  });

  it('folds a value whose digits come from two scripts', () => {
    expect(parseLocalizedNumber('٢5', 'ar')).toBe(25);
  });

  it('folds digits whose sets are adjacent in the code chart', () => {
    // Mathematical double-struck digits (U+1D7D8) follow the bold set with no
    // gap, and the Myanmar Pao set (U+116D0) touches the Eastern Pwo Karen one.
    expect(parseLocalizedNumber('𝟚𝟝', 'en')).toBe(25);
    expect(parseLocalizedNumber('𝟘', 'en')).toBe(0);
    expect(parseLocalizedNumber('𑛚𑛟', 'en')).toBe(5);
  });

  it('still rejects a value with a non-digit left in it', () => {
    expect(parseLocalizedNumber('٢٥x', 'ar')).toBeNull();
    expect(parseLocalizedNumber('٢٥٫٥٫٥', 'ar-EG')).toBeNull();
  });

  it.each(SUPPORTED_LANGUAGES)('round-trips its own formatted amount in %s', tag => {
    expect(parseLocalizedNumber(formatNumber(25.5, tag), tag)).toBe(25.5);
    expect(parseLocalizedNumber(formatNumber(1234.5, tag), tag)).toBe(1234.5);
  });

  it('normalizes to an ASCII literal so callers can compare magnitudes', () => {
    expect(normalizeLocalizedNumber('1.234,5', 'de-DE')).toBe('1234.5');
    expect(normalizeLocalizedNumber(' 1 234,5 ', 'ru')).toBe('1234.5');
    expect(normalizeLocalizedNumber('-12', 'en')).toBe('-12');
    expect(normalizeLocalizedNumber('twelve', 'en')).toBeNull();
    expect(normalizeLocalizedNumber('', 'en')).toBeNull();
    // Longer than a JS number can hold: the literal survives, the parse does not.
    expect(normalizeLocalizedNumber('9'.repeat(950), 'en')).toBe('9'.repeat(950));
    expect(parseLocalizedNumber('9'.repeat(950), 'en')).toBeNull();
  });

  it('formats a calendar date without a time-zone shift', () => {
    expect(formatCalendarDate('2026-08-03', 'en-US')).toBe('8/3/2026');
  });
});

describe('parseLocalizedNumber', () => {
  it('parses the forms the active language writes', () => {
    expect(parseLocalizedNumber('1.234,5', 'de-DE')).toBe(1234.5);
    expect(parseLocalizedNumber('1,5', 'de-DE')).toBe(1.5);
    expect(parseLocalizedNumber('1 234,5', 'ru')).toBe(1234.5);
    expect(parseLocalizedNumber('1,234.5', 'en-US')).toBe(1234.5);
    expect(parseLocalizedNumber('1.5', 'en-US')).toBe(1.5);
    expect(parseLocalizedNumber('1234', 'en-US')).toBe(1234);
    expect(parseLocalizedNumber('-2,5', 'de-DE')).toBe(-2.5);
    // The Indian numbering system groups the last three digits, then twos.
    expect(parseLocalizedNumber('1,23,456', 'hi')).toBe(123_456);
  });

  it('round-trips the digits and separators of a non-Latin locale', () => {
    expect(parseLocalizedNumber(formatNumber(1234.5, 'fa'), 'fa')).toBe(1234.5);
    expect(parseLocalizedNumber(formatNumber(1.5, 'bn'), 'bn')).toBe(1.5);
  });

  it('rejects input whose separators do not fit the locale', () => {
    // The field validates against the active language's separators and group
    // positions, so a value shaped for another language is not accepted.
    expect(parseLocalizedNumber('1.5', 'de-DE')).toBeNull();
    expect(parseLocalizedNumber('1,5', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('1,23,456', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('1,234.5', 'de-DE')).toBeNull();
    expect(parseLocalizedNumber('1,234,5', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('1 5', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('18,5', 'ar')).toBeNull();
    expect(parseLocalizedNumber('twelve', 'en')).toBeNull();
  });

  it('keeps accepting a partial decimal the way the field is typed', () => {
    expect(parseLocalizedNumber('1,', 'de-DE')).toBe(1);
    expect(parseLocalizedNumber(',5', 'de-DE')).toBe(0.5);
  });
});

describe('parseLocalizedNumber with the device keypad separator', () => {
  it('reads the decimal the device keypad writes when the language cannot', () => {
    // German app language on a device whose number keyboard writes `.`.
    expect(parseLocalizedNumber('2.5', 'de-DE', '.')).toBe(2.5);
    expect(parseLocalizedNumber('0.05', 'de-DE', '.')).toBe(0.05);
    expect(parseLocalizedNumber('2.', 'de-DE', '.')).toBe(2);
    expect(parseLocalizedNumber('.5', 'de-DE', '.')).toBe(0.5);
    // The mirror case: English app language on a comma keypad.
    expect(parseLocalizedNumber('2,5', 'en-US', ',')).toBe(2.5);
  });

  it('keeps the language reading when the language grammar can read the input', () => {
    expect(parseLocalizedNumber('1.234,5', 'de-DE', '.')).toBe(1234.5);
    expect(parseLocalizedNumber('1.234.567', 'de-DE', '.')).toBe(1_234_567);
    expect(parseLocalizedNumber('1,234.5', 'en-US', ',')).toBe(1234.5);
    // A space-sized group and the device separator sit together.
    expect(parseLocalizedNumber('1.5', 'ru', '.')).toBe(1.5);
    expect(parseLocalizedNumber('1 234,5', 'ru', '.')).toBe(1234.5);
  });

  it('rejects input the two readings disagree on', () => {
    // A thousand in German, or 1.234 from a dot keypad: the text does not say.
    expect(parseLocalizedNumber('1.234', 'de-DE', '.')).toBeNull();
    expect(parseLocalizedNumber('12.345', 'de-DE', '.')).toBeNull();
    expect(parseLocalizedNumber('1,234', 'en-US', ',')).toBeNull();
  });

  it('changes nothing when the device writes the language separator', () => {
    expect(parseLocalizedNumber('2.5', 'en-US', '.')).toBe(2.5);
    expect(parseLocalizedNumber('2,5', 'de-DE', ',')).toBe(2.5);
    expect(parseLocalizedNumber('1,5', 'en-US', '.')).toBeNull();
    expect(parseLocalizedNumber('1.5', 'de-DE', ',')).toBeNull();
  });
});
