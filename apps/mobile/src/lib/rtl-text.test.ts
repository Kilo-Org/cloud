import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  containsJoinedScript,
  hasRtlScript,
  JOINED_SCRIPT,
  NATURAL_LETTER_SPACING,
  textLetterSpacing,
} from './rtl-text';

// `rtl-text` imports `I18nManager` for its direction helpers; the real module
// is Flow-syntax source this node project cannot load.
vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

// U+0870 and U+089F are the first and last characters of Arabic Extended-B,
// the block between Arabic Supplement (ends U+077F) and Arabic Extended-A
// (starts U+08A0). A label using only its characters must still get the
// joining font the Arabic blocks select.
const FIRST_EXTENDED_B = '\u0870';
const LAST_EXTENDED_B = '\u089F';

describe('hasRtlScript', () => {
  it('detects a label written only in Arabic Extended-B characters', () => {
    expect(hasRtlScript(FIRST_EXTENDED_B + LAST_EXTENDED_B)).toBe(true);
  });

  it('detects the Arabic blocks around Arabic Extended-B', () => {
    expect(hasRtlScript('\u06FF')).toBe(true);
    expect(hasRtlScript('\u077F')).toBe(true);
    expect(hasRtlScript('\u08A0')).toBe(true);
    expect(hasRtlScript('\uFB50')).toBe(true);
    expect(hasRtlScript('\uFE70')).toBe(true);
  });

  // Hebrew is an RTL locale the app ships (`RTL_LANGUAGES` in
  // `@/i18n/languages`) and is not Arabic script, so the Arabic-only predicate
  // this replaced left its copy treated like Latin.
  it('detects the Hebrew block and its presentation forms', () => {
    expect(hasRtlScript('\u0590')).toBe(true);
    expect(hasRtlScript('\u05FF')).toBe(true);
    expect(hasRtlScript('\uFB1D')).toBe(true);
    expect(hasRtlScript('\uFB4F')).toBe(true);
  });

  it('detects a Hebrew label', () => {
    expect(hasRtlScript('פעילים עכשיו')).toBe(true);
  });

  it('walks the child tree to reach an Extended-B label', () => {
    expect(hasRtlScript(createElement('Text', null, FIRST_EXTENDED_B))).toBe(true);
  });

  it('leaves Latin copy alone', () => {
    expect(hasRtlScript('Live now')).toBe(false);
  });
});

describe('JOINED_SCRIPT', () => {
  it.each(['\u0600', '\u0750', '\u08A0', '\uFB50', '\uFE70'])(
    'covers the block that starts at %j',
    value => {
      expect(JOINED_SCRIPT.test(value)).toBe(true);
    }
  );
});

describe('containsJoinedScript', () => {
  it.each(['الجلسات الجارية الآن', 'الرئيسية', 'الوكلاء', 'الملف الشخصي', 'عرض الكل'])(
    'detects Arabic in %j',
    value => {
      expect(containsJoinedScript(value)).toBe(true);
    }
  );

  it.each([
    ['Arabic base', '\u0600'],
    ['Arabic Supplement', '\u0750'],
    ['Arabic Extended-A', '\u08A0'],
    ['Arabic Presentation Forms-A', '\uFB50'],
    ['Arabic Presentation Forms-B', '\uFE70'],
  ])('detects a glyph from %s', (_name, value) => {
    expect(containsJoinedScript(value)).toBe(true);
  });

  it('detects Arabic inside a mixed array of strings', () => {
    expect(containsJoinedScript(['عرض', ' ', 'الكل'])).toBe(true);
    expect(containsJoinedScript(['Live now', 'عرض الكل'])).toBe(true);
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
});

describe('textLetterSpacing', () => {
  it('returns the natural spacing for a joined script', () => {
    expect(textLetterSpacing('الرئيسية')).toBe(NATURAL_LETTER_SPACING);
    expect(textLetterSpacing(['عرض', ' الكل'])).toBe(NATURAL_LETTER_SPACING);
  });

  it('returns undefined without a joined script', () => {
    expect(textLetterSpacing('Live now')).toBeUndefined();
    expect(textLetterSpacing(4)).toBeUndefined();
  });
});
