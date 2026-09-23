import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { hasArabicScript } from './rtl-text';

vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

// U+0870 and U+089F are the first and last characters of Arabic Extended-B,
// the block between Arabic Supplement (ends U+077F) and Arabic Extended-A
// (starts U+08A0). A label using only its characters must still get the
// joining font the Arabic blocks select.
const FIRST_EXTENDED_B = '\u0870';
const LAST_EXTENDED_B = '\u089F';

describe('hasArabicScript', () => {
  it('detects a label written only in Arabic Extended-B characters', () => {
    expect(hasArabicScript(FIRST_EXTENDED_B + LAST_EXTENDED_B)).toBe(true);
  });

  it('detects the Arabic blocks around Arabic Extended-B', () => {
    expect(hasArabicScript('\u06FF')).toBe(true);
    expect(hasArabicScript('\u077F')).toBe(true);
    expect(hasArabicScript('\u08A0')).toBe(true);
    expect(hasArabicScript('\uFB50')).toBe(true);
    expect(hasArabicScript('\uFE70')).toBe(true);
  });

  it('walks the child tree to reach an Extended-B label', () => {
    expect(hasArabicScript(createElement('Text', null, FIRST_EXTENDED_B))).toBe(true);
  });

  it('leaves Latin copy alone', () => {
    expect(hasArabicScript('Live now')).toBe(false);
  });
});
