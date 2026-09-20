import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { containsJoinedScript, NATURAL_LETTER_SPACING, textLetterSpacing } from './rtl-text';

// `rtl-text` reads I18nManager at call time; the native module itself is not
// loadable under Node, so keep it out of the pure project's module graph.
vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

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
    ['English', 'Preferences'],
    ['Hebrew (right-to-left, not joined)', 'הגדרות'],
    ['Greek', 'Ρυθμίσεις'],
    ['Cyrillic', 'Настройки'],
    ['a number', '1.0.12'],
  ])('does not read a joined script in %s', (_name, text) => {
    expect(containsJoinedScript(text)).toBe(false);
  });

  it('reads every string in a child array and ignores non-text children', () => {
    expect(containsJoinedScript(['المظهر', undefined, 3, null])).toBe(true);
    expect(containsJoinedScript(['Appearance', 3])).toBe(false);
    expect(containsJoinedScript(3)).toBe(false);
  });

  it('leaves a nested element to its own run', () => {
    // A nested Text is a separate run and applies its own letter spacing.
    expect(containsJoinedScript(createElement('Text', null, 'التفصيلات'))).toBe(false);
  });

  it('returns the natural-spacing override only for a joined run', () => {
    expect(textLetterSpacing('المظهر')).toEqual(NATURAL_LETTER_SPACING);
    expect(textLetterSpacing('Appearance')).toBeUndefined();
  });
});
