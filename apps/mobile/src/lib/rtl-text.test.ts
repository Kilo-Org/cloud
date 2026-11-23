/* eslint-disable max-lines -- one suite for every direction helper the app resolves copy with: the script, joining, mono-family, block-direction, mark and input rules share fixtures and must read together */
import { createElement, Fragment } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenStyle } from '@/test/style-sheet-mock';

import {
  codeFieldTextStyle,
  containsJoinedScript,
  contentStringDirection,
  contentTextDirection,
  hasRtlScript,
  ltrValueTextStyle,
  markdownMessageDirection,
  pinsTextDirection,
  rtlBaseMarkedChildren,
  withoutLeadingDirectionMarks,
  withoutMonoFamily,
} from './rtl-text';

// `rtl-text` imports `I18nManager` and `StyleSheet` from `react-native`; the
// real module is Flow-syntax source this node project cannot load. Hoisted so a
// test can flip the interface direction between calls.
const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  StyleSheet: { flatten: flattenStyle },
}));

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

  // The script detection the RTL label treatment was first built on: a plain
  // string, a mixed array, and a nested element all reach the copy, so a label
  // that mixes scripts counts as RTL script.
  it('detects an Arabic string', () => {
    expect(hasRtlScript('الجلسات الجارية الآن')).toBe(true);
  });

  it('detects Arabic inside a mixed array of strings', () => {
    expect(hasRtlScript(['LIVE NOW', 'عرض الكل'])).toBe(true);
  });

  it('checks every item of an array', () => {
    expect(hasRtlScript(['LIVE', 'NOW'])).toBe(false);
  });

  it('recurses into a nested element', () => {
    expect(hasRtlScript(createElement('Text', null, 'استكشاف'))).toBe(true);
  });

  it('is false for a number, a boolean and null', () => {
    expect(hasRtlScript(42)).toBe(false);
    expect(hasRtlScript(true)).toBe(false);
    expect(hasRtlScript(null)).toBe(false);
  });
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
    ['Arabic Extended-B', '\u0870'],
    ['Arabic Extended-A', '\u08A0'],
    ['Arabic Presentation Forms-A', '\uFB50'],
    ['Arabic Presentation Forms-B', '\uFE70'],
  ])('detects a glyph from %s', (_name, value) => {
    expect(containsJoinedScript(value)).toBe(true);
  });

  // Arabic Extended-B sits between Arabic Supplement and Arabic Extended-A;
  // `hasRtlScript` reads it for the mono family, so the reset reads it too.
  it('detects a label written only in Arabic Extended-B', () => {
    expect(containsJoinedScript(FIRST_EXTENDED_B + LAST_EXTENDED_B)).toBe(true);
  });

  it.each(['الجلسات الجارية الآن', 'الرئيسية', 'الوكلاء', 'الملف الشخصي', 'عرض الكل'])(
    'detects Arabic in %j',
    value => {
      expect(containsJoinedScript(value)).toBe(true);
    }
  );

  it.each([
    ['Hindi (Devanagari)', 'अभी'],
    ['Bengali', 'এখন'],
    ['Punjabi (Gurmukhi)', 'ਹੁਣ'],
    ['Gujarati', 'હવે'],
    ['Odia', 'ବର୍ତ୍ତମାନ'],
    ['Tamil', 'இப்போது'],
    ['Telugu', 'ఇప్పుడు'],
    ['Kannada', 'ಈಗ'],
    ['Malayalam', 'ഇപ്പോൾ'],
    ['Sinhala', 'දැන්'],
    ['Thai', 'ตอนนี้'],
    ['Lao', 'ດຽວນີ້'],
    ['Myanmar', 'ယခု'],
    ['Khmer', 'ឥឡូវនេះ'],
  ])('reads a combining cluster script in %s', (_name, text) => {
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

describe('withoutMonoFamily', () => {
  it('drops the mono family and preserves the remaining order', () => {
    expect(withoutMonoFamily('font-mono-medium text-[10px] uppercase text-muted-foreground')).toBe(
      'text-[10px] uppercase text-muted-foreground'
    );
  });

  it('drops a variant-prefixed mono family', () => {
    expect(withoutMonoFamily('dark:font-mono-semibold text-sm')).toBe('text-sm');
  });

  it('keeps an unrelated token that merely starts with font-mono', () => {
    expect(withoutMonoFamily('font-mono-bold text-sm')).toBe('font-mono-bold text-sm');
  });
});

describe('contentTextDirection', () => {
  afterEach(() => {
    i18nManager.isRTL = false;
  });

  const LTR = { direction: 'ltr', writingDirection: 'ltr' };
  const RTL = { direction: 'rtl', writingDirection: 'rtl' };

  // Copy the app did not write takes the direction of its own first strong
  // character, so an English sentence keeps its left edge inside an Arabic
  // interface, and an Arabic one still aligns to the right. The node's layout
  // `direction` is named too: iOS resolves a paragraph's alignment from it, not
  // from `writingDirection`.
  it.each([false, true])('names English content left to right (isRTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    expect(contentTextDirection('1. Prototype pollution: لا')).toEqual(LTR);
  });

  it.each([false, true])('names Arabic content right to left (isRTL=%s)', isRTL => {
    i18nManager.isRTL = isRTL;
    expect(contentTextDirection(['  ', createElement('Text', null, 'تلوث Prototype')])).toEqual(
      RTL
    );
  });

  // Hebrew, and the right-to-left scripts the app has no glyphs for, still
  // arrive in content: Syriac, Thaana, NKo, Samaritan, Mandaic, Adlam, and the
  // supplementary scripts Unicode classes R — Cypriot, Lydian, Meroitic.
  it.each(['שלום', 'ܫܠܡܐ', 'ދިވެހި', 'ߒߞߏ', 'ࠀࠁ', 'ࡀࡁ', '𞤀𞤁', '𐠀𐠁', '𐤠𐤡', '𐦀𐦁'])(
    'names %s content right to left',
    text => {
      expect(contentTextDirection(`1. ${text}`)).toEqual(RTL);
    }
  );

  it('names Greek and Cyrillic content left to right', () => {
    expect(contentTextDirection('Ελληνικά')).toEqual(LTR);
    expect(contentTextDirection('Русский')).toEqual(LTR);
  });

  // The paragraph direction comes from its first letter, and a direction mark
  // is not a letter: a mark the content put in front of a block does not decide
  // that block's direction, so the letter after it does. Letting the mark
  // decide is what put two rows of one fallback block on opposite edges.
  it.each([
    ['\u200FAlpha beta', LTR],
    ['\u200Eبيتا', RTL],
    ['\u061CAlpha beta', LTR],
  ])('names the direction a block’s own letter chooses, not a leading mark', (text, expected) => {
    expect(contentTextDirection(text)).toEqual(expected);
  });

  it('leaves copy with no letter to the interface', () => {
    expect(contentTextDirection(['42 · ', 7])).toBeUndefined();
  });
});

describe('contentStringDirection', () => {
  it('names a block from its own first letter', () => {
    expect(contentStringDirection('Latin text and more here.')).toBe('ltr');
    expect(contentStringDirection('مرحبا')).toBe('rtl');
  });

  // The HTML render path asks this of a block's own text; a block that holds no
  // letter is left to the message (`markdownMessageDirection`).
  it('names nothing for a block whose text holds no letter', () => {
    expect(contentStringDirection('42 · 7')).toBeUndefined();
    expect(contentStringDirection('\u200FLatin')).toBe('ltr');
  });
});

describe('markdownMessageDirection', () => {
  it('takes the message direction from its first letter', () => {
    expect(markdownMessageDirection('- Latin bullet')).toBe('ltr');
    expect(markdownMessageDirection('مرحبا بك')).toBe('rtl');
  });

  // The fallback block's own middle row opens on a tag whose name starts with a
  // Latin letter: markup is not copy, so it must not decide the message.
  it('reads past HTML tag syntax and its attribute values', () => {
    expect(
      markdownMessageDirection('<custom-note class="kilo-block-rtl">Latin text</custom-note>')
    ).toBe('ltr');
    expect(markdownMessageDirection('<custom-note>مرحبا</custom-note>')).toBe('rtl');
  });

  it('reads a leading mark as no letter, so the letter after it decides', () => {
    expect(markdownMessageDirection('\u200FLatin bullet')).toBe('ltr');
    expect(markdownMessageDirection('\u200Eمرحبا')).toBe('rtl');
  });

  it('names nothing for a message that holds no letter', () => {
    expect(markdownMessageDirection('42 · 7')).toBeUndefined();
    expect(markdownMessageDirection('<custom-note>\u200F</custom-note>')).toBeUndefined();
  });

  // Machinery is Latin whatever language the message is in, so a message that
  // opens with it still names the direction of the Arabic prose after it.
  it.each([
    ['a fenced code block', '```bash\npnpm install\n```\n\nمرحبا، هذا نص عربي.'],
    ['a code span', '`pnpm install` ثم مرحبا بالجميع'],
    ['a bare URL', 'https://example.com\n\nمرحبا بالجميع'],
    ['a link reference definition', '[docs]: https://example.com\n\nمرحبا بالجميع'],
    ['an indented code block', '    pnpm install\n\nمرحبا بالجميع'],
  ])('reads the prose after %s, not the machinery', (_kind, message) => {
    expect(markdownMessageDirection(message)).toBe('rtl');
  });

  // A table header, a link label and an image's alt text are copy a person
  // reads, so their own letters decide like any other prose.
  it('keeps the copy a reader reads', () => {
    expect(markdownMessageDirection('[مرحبا](https://example.com)')).toBe('rtl');
    expect(markdownMessageDirection('| جدول | b |\n| - | - |')).toBe('rtl');
    expect(markdownMessageDirection('![مرحبا](https://example.com/a.png)')).toBe('rtl');
  });

  // A quoted attribute may hold the tag's own closing character, so the scan
  // tracks the quote instead of stopping at the first `>`.
  it('skips a whole tag whose attribute holds a closing angle bracket', () => {
    expect(markdownMessageDirection('<a title="a>b">مرحبا بالجميع')).toBe('rtl');
    expect(markdownMessageDirection("<a title='a>b'>مرحبا بالجميع")).toBe('rtl');
  });

  // A code span opens on a run of N backticks and closes on the next run of
  // exactly N, so a span may hold a shorter run.
  it('skips a code span opened by a run of backticks', () => {
    expect(markdownMessageDirection('``a`b`` مرحبا بالجميع')).toBe('rtl');
    expect(markdownMessageDirection('``a`b`` ثم مرحبا')).toBe('rtl');
    expect(markdownMessageDirection('``مرحبا`` بالجميع')).toBe('rtl');
  });

  it('names nothing for a message whose only letters are machinery', () => {
    expect(markdownMessageDirection('```bash\npnpm install\n```')).toBeUndefined();
    expect(markdownMessageDirection('``a`b``')).toBeUndefined();
    expect(markdownMessageDirection('<a title="a>b">')).toBeUndefined();
  });
});

describe('withoutLeadingDirectionMarks', () => {
  // The design gate's fallback block: the third row is a bullet whose content
  // wrote a right-to-left mark before its Latin text, so the paragraph laid out
  // right to left while the Latin rows above and below it named their own edge.
  it('strips the mark a bullet wrote in front of its content', () => {
    expect(withoutLeadingDirectionMarks('- \u200FLatin bullet')).toBe('- Latin bullet');
  });

  it('strips a mark in front of a paragraph, a heading, and a nested quote', () => {
    expect(withoutLeadingDirectionMarks('\u200FLatin text and more here.')).toBe(
      'Latin text and more here.'
    );
    expect(withoutLeadingDirectionMarks('## \u200FHeading')).toBe('## Heading');
    expect(withoutLeadingDirectionMarks('> > \u200FQuoted')).toBe('> > Quoted');
    expect(withoutLeadingDirectionMarks('1. \u200FItem')).toBe('1. Item');
  });

  it('leaves a mark inside a block’s text alone, where it orders its own run', () => {
    expect(withoutLeadingDirectionMarks('Kilo \u200Fغير متصل')).toBe('Kilo \u200Fغير متصل');
  });

  // A task item's checkbox is its own machinery: the text the reader reads
  // starts after it, so a mark there still names the item's edge.
  it('strips the mark behind a task checkbox', () => {
    expect(withoutLeadingDirectionMarks('- [ ] \u200FLatin task')).toBe('- [ ] Latin task');
    expect(withoutLeadingDirectionMarks('- [x] \u200FLatin done')).toBe('- [x] Latin done');
  });

  it('strips the mark behind an emphasis opener', () => {
    expect(withoutLeadingDirectionMarks('- **\u200FLatin**')).toBe('- **Latin**');
    expect(withoutLeadingDirectionMarks('## __\u200FLatin__')).toBe('## __Latin__');
    expect(withoutLeadingDirectionMarks('1. ~~\u200FLatin~~')).toBe('1. ~~Latin~~');
  });

  // The mark is the link label's own first character, and the label is the
  // block's text: the destination after it is a URL, not the block's opening.
  it('strips the mark that opens a link label', () => {
    expect(withoutLeadingDirectionMarks('- [\u200FLatin](https://example.com)')).toBe(
      '- [Latin](https://example.com)'
    );
  });

  // A reference is looked up by a key of its label's text, so dropping the mark
  // would rename the key and point the link elsewhere: it stays.
  it('keeps the mark that opens a reference label', () => {
    const value = '- [\u200FLatin][ref]\n\n[ref]: https://example.com';
    expect(withoutLeadingDirectionMarks(value)).toBe(value);
  });

  // A paragraph may be indented up to three spaces and still be one; a mark
  // after that indentation is in front of the paragraph's first character.
  it('strips a mark after up to three spaces of indentation', () => {
    expect(withoutLeadingDirectionMarks('  \u200FLatin indented')).toBe('  Latin indented');
    expect(withoutLeadingDirectionMarks('   \u200FLatin indented')).toBe('   Latin indented');
  });

  // An inline code span is code the content wrote: only the mark in front of the
  // span is the block's, and a mark deeper inside it orders that code run.
  it('keeps a mark written deeper inside an inline code span', () => {
    expect(withoutLeadingDirectionMarks('- `\u200FLatin code`')).toBe('- `Latin code`');
    const inside = '- `a \u200Fb`';
    expect(withoutLeadingDirectionMarks(inside)).toBe(inside);
  });

  it('leaves a continuation line and the rest of the source byte-identical', () => {
    const value = '\u200FFirst\nsecond \u200Fline\n\n- \u200Fitem';
    expect(withoutLeadingDirectionMarks(value)).toBe('First\nsecond \u200Fline\n\n- item');
  });

  it('leaves fenced and indented code untouched', () => {
    const fenced = '```js\nconst \u200Fa = 1;\n```';
    expect(withoutLeadingDirectionMarks(fenced)).toBe(fenced);
    const indented = '\u200FIntro\n\n    const \u200Fa = 1;';
    expect(withoutLeadingDirectionMarks(indented)).toBe('Intro\n\n    const \u200Fa = 1;');
  });

  // A mark can stand where a block marker would otherwise be: the line is a
  // paragraph only because the mark interrupts it, so removing that mark would
  // turn the paragraph into a heading, a list item, a quote or a fence. The
  // strip keeps the document's blocks, so such a mark stays. The last four are
  // the markers that also open a block: a thematic break, an HTML block, a
  // reference definition, and an indented code line.
  it.each([
    ['  \u200F# Latin', 'an indented heading'],
    ['\u200F# Latin', 'a heading at the content start'],
    ['  \u200F- Latin', 'an indented bullet'],
    ['  \u200F1. Latin', 'an indented ordered item'],
    ['  \u200F+ Latin', 'an indented plus bullet'],
    ['  \u200F> Latin', 'an indented quote'],
    ['  \u200F```js', 'an indented fence'],
    ['  \u200F---', 'an indented thematic break'],
    ['  \u200F***', 'an indented starred thematic break'],
    ['\u200F<div>x</div>', 'an HTML block'],
    ['\u200F[ref]: /url', 'a reference definition'],
    ['  \u200F    code', 'an indented code line'],
  ])('keeps a mark in front of %s (%s)', (value, _shape) => {
    expect(withoutLeadingDirectionMarks(value)).toBe(value);
  });

  // Inside a heading's own text no marker can open another block, so the mark
  // there is only an edge and goes: keeping it would leave the heading on the
  // wrong one, which is the defect this strip exists for. A heading can sit
  // inside a list item or a quote, so those shapes are read as headings too.
  it.each(['# \u200F# Latin', '- # \u200FLatin', '> # \u200FLatin'])(
    'strips a mark inside a heading that would not open a block there (%s)',
    value => {
      expect(withoutLeadingDirectionMarks(value)).toBe(value.replace('\u200F', ''));
    }
  );

  // A heading can also sit inside a list item, and there the item's content
  // indent decides whether the text after the marker is the item's prose or an
  // indented code block. Five or more columns of padding after the marker leave
  // code, whose text keeps every character it holds. A tab reaches the next
  // four-column stop, so the columns are counted rather than the characters.
  it('keeps a mark in a list item whose padding makes an indented code block', () => {
    const code = '-     # \u200FLatin';
    expect(withoutLeadingDirectionMarks(code)).toBe(code);
    expect(withoutLeadingDirectionMarks('-     Latin')).toBe('-     Latin');
  });

  it('counts tab padding in columns for that rule', () => {
    const code = '-\t\t# \u200FLatin';
    expect(withoutLeadingDirectionMarks(code)).toBe(code);
    // One tab reaches column 4, which is still the item's own indent.
    expect(withoutLeadingDirectionMarks('-\t# \u200FLatin')).toBe('-\t# Latin');
  });

  it('returns the same string when there is no mark to strip', () => {
    expect(withoutLeadingDirectionMarks('42 · 7\n\n- Latin bullet')).toBe(
      '42 · 7\n\n- Latin bullet'
    );
  });
});

describe('rtlBaseMarkedChildren', () => {
  afterEach(() => {
    i18nManager.isRTL = false;
  });

  // The Bitbucket denial sentence: it opens on a Latin product name and then
  // holds Arabic words.
  const MIXED = 'Bitbucket غير متصل. يمكن لمالكي المؤسسة ربطه.';

  it('prefixes a Latin-first label that holds Arabic copy in an RTL interface', () => {
    i18nManager.isRTL = true;
    expect(rtlBaseMarkedChildren(MIXED, true)).toBe(`\u200F${MIXED}`);
  });

  it('prefixes a Latin-first label that holds Hebrew copy', () => {
    i18nManager.isRTL = true;
    expect(rtlBaseMarkedChildren('Bitbucket לא מחובר.', true)).toBe('\u200FBitbucket לא מחובר.');
  });

  it('leaves a label that already opens right to left alone', () => {
    i18nManager.isRTL = true;
    expect(rtlBaseMarkedChildren('استكشف', true)).toBe('استكشف');
  });

  it('leaves Latin-only copy alone, so its full stop stays on the word', () => {
    i18nManager.isRTL = true;
    expect(rtlBaseMarkedChildren('Sentry.', hasRtlScript('Sentry.'))).toBe('Sentry.');
  });

  it('leaves the copy alone in a left-to-right interface', () => {
    expect(i18nManager.isRTL).toBe(false);
    expect(rtlBaseMarkedChildren(MIXED, true)).toBe(MIXED);
  });

  // The caller's script scan decides whether the tree holds an Arabic or Hebrew
  // letter: with no such letter there is no interface direction to name.
  it('leaves the copy alone when the caller scanned no right-to-left script', () => {
    i18nManager.isRTL = true;
    expect(rtlBaseMarkedChildren(MIXED, false)).toBe(MIXED);
  });

  it('puts the mark in front of a child tree that is not one string', () => {
    i18nManager.isRTL = true;
    const child = createElement('Text', null, 'Kilo غير متصل');
    expect(rtlBaseMarkedChildren(child, true)).toEqual(
      createElement(Fragment, null, '\u200F', child)
    );
  });
});

describe('pinsTextDirection', () => {
  it('reports a left-to-right pin', () => {
    expect(pinsTextDirection({ direction: 'ltr', writingDirection: 'ltr' })).toBe(true);
  });

  it('reports a right-to-left pin', () => {
    expect(pinsTextDirection({ direction: 'rtl', writingDirection: 'rtl' })).toBe(true);
  });

  // A caller that names only the iOS spelling has still named the direction.
  it('reports a pin that names only the writing direction', () => {
    expect(pinsTextDirection({ writingDirection: 'rtl' })).toBe(true);
  });

  it('reports no pin for a style that names neither', () => {
    expect(pinsTextDirection({ textAlign: 'right', letterSpacing: 0 })).toBe(false);
  });

  // Neither value names a direction: `inherit` follows the parent's layout and
  // `auto` resolves from the first strong character, which is what the mark
  // decides. A shared style carrying either must not suppress the mark.
  it('reports no pin for a value that leaves the direction open', () => {
    expect(pinsTextDirection({ direction: 'inherit' })).toBe(false);
    expect(pinsTextDirection({ writingDirection: 'auto' })).toBe(false);
  });

  // A style array is flattened before the read, so a pin in any entry counts.
  it('reads a pin inside a style array', () => {
    expect(pinsTextDirection([{ letterSpacing: 0 }, [{ direction: 'ltr' }]])).toBe(true);
    expect(pinsTextDirection([{ letterSpacing: 0 }, undefined, false])).toBe(false);
  });

  it('reports no pin for an absent or empty style', () => {
    expect(pinsTextDirection(undefined)).toBe(false);
    expect(pinsTextDirection({})).toBe(false);
  });
});

describe('ltrValueTextStyle', () => {
  it('keeps a value in its natural left alignment in a left-to-right interface', () => {
    expect(ltrValueTextStyle()).toEqual({ direction: 'ltr', writingDirection: 'ltr' });
  });

  // A path starts with a neutral character and a number can carry a sign, so a
  // right-to-left paragraph would move either to the other end of the run. The
  // alignment puts the block under its label, which already uses that edge.
  it('pins a value to left-to-right order on the interface start edge in a right-to-left interface', () => {
    i18nManager.isRTL = true;
    try {
      expect(ltrValueTextStyle()).toEqual({
        direction: 'ltr',
        writingDirection: 'ltr',
        textAlign: 'right',
      });
    } finally {
      i18nManager.isRTL = false;
    }
    expect(ltrValueTextStyle().textAlign).toBeUndefined();
  });
});

describe('codeFieldTextStyle', () => {
  // A command keeps its left edge in a right-to-left interface, where a named
  // value sits on the label's right edge instead.
  it('pins a command to the left edge in both directions', () => {
    i18nManager.isRTL = true;
    try {
      expect(codeFieldTextStyle().textAlign).toBe('left');
    } finally {
      i18nManager.isRTL = false;
    }
    expect(codeFieldTextStyle()).toMatchObject({
      direction: 'ltr',
      writingDirection: 'ltr',
      textAlign: 'left',
    });
  });

  // The mono face draws the `--` of a flag as one long dash, so a command read
  // off the screen shows a dash the shell does not accept.
  it('turns the family ligatures off so a flag keeps its hyphens', () => {
    expect(codeFieldTextStyle().fontVariant).toEqual([
      'no-common-ligatures',
      'no-discretionary-ligatures',
      'no-contextual',
    ]);
  });
});
