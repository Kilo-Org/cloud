import { describe, expect, it } from 'vitest';

import {
  firstGrapheme,
  formatCalendarDate,
  formatCurrency,
  formatFileSize,
  formatList,
  formatMoney,
  formatMoneyFromCents,
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
    expect(de).not.toBe(en);
  });

  it('keeps the USD symbol the active language writes', () => {
    // Several languages disambiguate the dollar currency; the formatter's own
    // symbol must survive, the same way the non-USD branch keeps it.
    expect(formatMoney(1234.5, 'pt')).toMatch(/^1234,50[\s\u00A0\u202F]+US\$$/);
    expect(formatMoney(1234.5, 'ar')).toContain('US$');
    expect(formatMoney(1234.5, 'fr')).toMatch(/\$US$/);
    expect(formatMoneyFromCents(123_450, 'pt')).toBe(formatCurrency(1234.5, 'pt', 2));
  });

  it('uses Portugal rules for Portuguese and Brazil rules for Brazilian Portuguese', () => {
    expect(formatMoney(1234.5, 'pt')).toMatch(/^1234,50[\s\u00A0\u202F]+US\$$/);
    expect(formatMoney(1234.5, 'pt-BR')).toMatch(/^US\$[\s\u00A0\u202F]*1\.234,50$/);
  });
});

describe('localized format helpers', () => {
  it('formats a list and preserves one grapheme', () => {
    expect(formatList(['A', 'B'], 'de')).toBe('A und B');
    expect(formatFileSize(1024, 'de')).toContain('1 kB');
    expect(firstGrapheme('👨‍👩‍👧‍👦 family', 'en')).toBe('👨‍👩‍👧‍👦');
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
