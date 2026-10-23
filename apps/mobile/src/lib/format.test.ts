import { describe, expect, it } from 'vitest';

import {
  firstGrapheme,
  formatCalendarDate,
  formatFileSize,
  formatList,
  formatMoney,
  parseLocalizedNumber,
  toAsciiDigits,
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
    expect(parseLocalizedNumber('١٢٣٤', 'ar-EG')).toBe(1234);
    expect(parseLocalizedNumber('twelve', 'en')).toBeNull();
  });

  it('formats a calendar date without a time-zone shift', () => {
    expect(formatCalendarDate('2026-08-03', 'en-US')).toBe('8/3/2026');
  });
});

describe('toAsciiDigits', () => {
  it('converts the Arabic-Indic digits a phone keyboard types for a code', () => {
    expect(toAsciiDigits('٢٤٦٨١٠', 'ar')).toBe('246810');
  });

  it.each([
    ['Extended Arabic-Indic', '۲۴۶۸۱۰', 'fa'],
    ['Devanagari', '२४६८१०', 'hi'],
  ])('converts %s digits', (_script, digits, locale) => {
    expect(toAsciiDigits(digits, locale)).toBe('246810');
  });

  it('converts the active numbering system of a locale', () => {
    expect(toAsciiDigits('২৪৬৮১০', 'bn')).toBe('246810');
    expect(toAsciiDigits('၇', 'my')).toBe('7');
  });

  it('converts each digit of a mixed-script value and leaves other characters alone', () => {
    expect(toAsciiDigits('٢٤6٨١0', 'ar')).toBe('246810');
    expect(toAsciiDigits('24a6', 'en')).toBe('24a6');
    expect(toAsciiDigits('', 'ar')).toBe('');
  });
});
