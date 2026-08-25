import { describe, expect, it } from 'vitest';

import {
  firstGrapheme,
  formatFileSize,
  formatList,
  formatMoney,
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
});
