import { describe, expect, it } from 'vitest';

import { SUPPORTED_LANGUAGES } from '@/i18n/languages';

import {
  firstGrapheme,
  formatCalendarDate,
  formatFileSize,
  formatList,
  formatMoney,
  formatNumber,
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

  it('still rejects a value with a non-digit left in it', () => {
    expect(parseLocalizedNumber('٢٥x', 'ar')).toBeNull();
    expect(parseLocalizedNumber('٢٥٫٥٫٥', 'ar-EG')).toBeNull();
  });

  it.each(SUPPORTED_LANGUAGES)('round-trips its own formatted amount in %s', tag => {
    expect(parseLocalizedNumber(formatNumber(25.5, tag), tag)).toBe(25.5);
    expect(parseLocalizedNumber(formatNumber(1234.5, tag), tag)).toBe(1234.5);
  });

  it('formats a calendar date without a time-zone shift', () => {
    expect(formatCalendarDate('2026-08-03', 'en-US')).toBe('8/3/2026');
  });
});
