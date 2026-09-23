import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  containsJoinedScript,
  JOINED_SCRIPT,
  NATURAL_LETTER_SPACING,
  textLetterSpacing,
} from './rtl-text';

// `rtl-text` imports `I18nManager` for its direction helpers; the real module
// is Flow-syntax source this node project cannot load.
vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

describe('JOINED_SCRIPT', () => {
  it.each(['\u0600', '\u0750', '\u08A0', '\uFB50', '\uFE70'])(
    'covers the block that starts at %j',
    value => {
      expect(JOINED_SCRIPT.test(value)).toBe(true);
    }
  );
});

describe('containsJoinedScript', () => {
  it.each([
    ['Arabic heading', 'التفصيلات'],
    ['Arabic section label', 'أعلام المميزات'],
    ['Farsi', 'تنظیمات'],
    ['Urdu', 'ترجیحات'],
    ['Kurdish (Sorani)', 'ڕێکخستنەکان'],
    ['Pashto', 'تنظیمات'],
    ['Arabic presentation form', '\uFB50\uFB51'],
    ['a Latin run quoting an Arabic word', 'Saved · محفوظ'],
  ])('reads a joined script in %s', (_name, text) => {
    expect(containsJoinedScript(text)).toBe(true);
  });

  it.each([
    ['Arabic base', '\u0600'],
    ['Arabic Supplement', '\u0750'],
    ['Arabic Extended-A', '\u08A0'],
    ['Arabic Presentation Forms-A', '\uFB50'],
    ['Arabic Presentation Forms-B', '\uFE70'],
  ])('detects a glyph from %s', (_name, value) => {
    expect(containsJoinedScript(value)).toBe(true);
  });

  it.each(['الجلسات الجارية الآن', 'الرئيسية', 'الوكلاء', 'الملف الشخصي', 'عرض الكل'])(
    'detects Arabic in %j',
    value => {
      expect(containsJoinedScript(value)).toBe(true);
    }
  );

  it.each([
    ['English', 'Preferences'],
    ['Hebrew (right-to-left, not joined)', 'הגדרות'],
    ['Greek', 'Ρυθμίσεις'],
    ['Cyrillic', 'Настройки'],
    ['a number', '1.0.12'],
  ])('does not read a joined script in %s', (_name, text) => {
    expect(containsJoinedScript(text)).toBe(false);
  });

  it('detects Arabic inside a mixed array of strings', () => {
    expect(containsJoinedScript(['عرض', ' ', 'الكل'])).toBe(true);
    expect(containsJoinedScript(['Live now', 'عرض الكل'])).toBe(true);
  });

  it('reads every string in a child array and ignores non-text children', () => {
    expect(containsJoinedScript(['المظهر', undefined, 3, null])).toBe(true);
    expect(containsJoinedScript(['Appearance', 3])).toBe(false);
    expect(containsJoinedScript(3)).toBe(false);
  });

  it('is false for Latin, Hebrew, digits and punctuation', () => {
    expect(containsJoinedScript('Live now')).toBe(false);
    expect(containsJoinedScript('SEE ALL')).toBe(false);
    expect(containsJoinedScript('שלום')).toBe(false);
    expect(containsJoinedScript('1234 56.7%!?')).toBe(false);
    expect(containsJoinedScript(['Live now', '1234'])).toBe(false);
  });

  it('is false for empty children', () => {
    expect(containsJoinedScript(undefined)).toBe(false);
    expect(containsJoinedScript(null)).toBe(false);
    expect(containsJoinedScript(false)).toBe(false);
    expect(containsJoinedScript([])).toBe(false);
    expect(containsJoinedScript('')).toBe(false);
  });

  it('is false for number and element children', () => {
    expect(containsJoinedScript(4)).toBe(false);
    expect(containsJoinedScript(createElement('Text', null, 'الرئيسية'))).toBe(false);
  });

  it('leaves a nested element to its own run', () => {
    // A nested Text is a separate run and applies its own letter spacing.
    expect(containsJoinedScript(createElement('Text', null, 'التفصيلات'))).toBe(false);
  });
});

describe('textLetterSpacing', () => {
  it('returns the natural-spacing override only for a joined run', () => {
    expect(textLetterSpacing('المظهر')).toEqual(NATURAL_LETTER_SPACING);
    expect(textLetterSpacing('Appearance')).toBeUndefined();
  });

  it('returns the natural spacing for a joined script', () => {
    expect(textLetterSpacing('الرئيسية')).toBe(NATURAL_LETTER_SPACING);
    expect(textLetterSpacing(['عرض', ' الكل'])).toBe(NATURAL_LETTER_SPACING);
  });

  it('returns undefined without a joined script', () => {
    expect(textLetterSpacing('Live now')).toBeUndefined();
    expect(textLetterSpacing(4)).toBeUndefined();
  });
});
