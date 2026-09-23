import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { hasRtlScript } from './rtl-text';

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
