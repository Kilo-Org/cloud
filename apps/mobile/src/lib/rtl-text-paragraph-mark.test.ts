import { describe, expect, it, vi } from 'vitest';

import { flattenStyle } from '@/test/style-sheet-mock';

import { withRtlParagraphMark } from './rtl-text';

// `rtl-text` imports `I18nManager` and `StyleSheet` from `react-native`; the
// real module is Flow-syntax source this node project cannot load. Hoisted so a
// test can flip the interface direction between calls.
const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  StyleSheet: { flatten: flattenStyle },
}));

describe('withRtlParagraphMark', () => {
  // Android resolves a paragraph's order from its first strong character, and
  // `writingDirection` reaches iOS only. A sentence that opens with a Latin
  // product name inside a right-to-left interface (`Bitbucket متاح للمؤسسات
  // فقط.`) therefore drew left to right: the name at the left end, the full stop
  // at the right. The mark names the interface's direction without drawing.
  it('prefixes an invisible strong right-to-left character in a right-to-left interface', () => {
    i18nManager.isRTL = true;
    try {
      expect(withRtlParagraphMark('Bitbucket متاح للمؤسسات فقط.')).toBe(
        '\u200FBitbucket متاح للمؤسسات فقط.'
      );
    } finally {
      i18nManager.isRTL = false;
    }
  });

  // A Latin sentence resolves left to right from its own first letter, so a mark
  // in front of it would flip the paragraph: the full stop that ends it would
  // move to the other end of the line. An untranslated English string in a
  // right-to-left interface reaches this helper too.
  it('leaves Latin copy untouched in a right-to-left interface', () => {
    i18nManager.isRTL = true;
    try {
      expect(withRtlParagraphMark('Bitbucket is available for organizations only.')).toBe(
        'Bitbucket is available for organizations only.'
      );
      expect(withRtlParagraphMark('42 — no letter')).toBe('42 — no letter');
    } finally {
      i18nManager.isRTL = false;
    }
  });

  it('leaves copy untouched in a left-to-right interface', () => {
    expect(withRtlParagraphMark('Bitbucket is available for organizations only.')).toBe(
      'Bitbucket is available for organizations only.'
    );
    expect(withRtlParagraphMark('Bitbucket متاح للمؤسسات فقط.')).toBe(
      'Bitbucket متاح للمؤسسات فقط.'
    );
  });
});
