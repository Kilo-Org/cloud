import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { containsJoinedScript, NATURAL_LETTER_SPACING, textLetterSpacing } from './rtl-text';

vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

const JOINED = [
  'التفصيلات',
  'تنظیمات',
  'ترجیحات',
  'ڕێکخستنەکان',
  'تنظیمات',
  '\uFB50\uFB51',
  'Saved · محفوظ',
];

const NOT_JOINED = ['Preferences', 'הגדרות', 'Ρυθμίσεις', 'Настройки', '1.0.12'];

describe('containsJoinedScript', () => {
  it.each(JOINED)('reads a joined script in %s', text => {
    expect(containsJoinedScript(text)).toBe(true);
  });

  it.each(NOT_JOINED)('leaves %s alone', text => {
    expect(containsJoinedScript(text)).toBe(false);
  });

  it('scans a child array and ignores non-text children', () => {
    expect(containsJoinedScript(['المظهر', undefined, 3, null])).toBe(true);
    expect(containsJoinedScript(['Appearance', 3])).toBe(false);
    expect(containsJoinedScript(3)).toBe(false);
  });

  it('leaves a nested element to its own run', () => {
    expect(containsJoinedScript(createElement('Text', null, 'التفصيلات'))).toBe(false);
  });
});

describe('textLetterSpacing', () => {
  it('resets letter spacing on a joined script', () => {
    expect(textLetterSpacing('المظهر')).toBe(NATURAL_LETTER_SPACING);
  });

  it('leaves a Latin run without a reset', () => {
    expect(textLetterSpacing('Appearance')).toBeUndefined();
  });
});
