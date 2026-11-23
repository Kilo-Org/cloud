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

  // An indented code block runs on while the lines keep its indentation, exactly
  // as the strip's walk reads one. Only its first line was read as code before,
  // so the continuation line's Arabic was taken for prose and the message named
  // a direction it has no prose letter for.
  it('reads a multi-line indented code block as machinery throughout', () => {
    expect(markdownMessageDirection('    مرحبا\n    بك')).toBeUndefined();
    expect(markdownMessageDirection('    مرحبا\n    بك\n\nLatin')).toBe('ltr');
  });

  // A fence closes only on its own marker at least as long as the run that
  // opened it, so a ``` line inside a `~~~` block is that block's text. Toggling
  // on any fence line ended the block there and read the Arabic under it as
  // prose.
  it('closes a fence only on its own marker', () => {
    expect(markdownMessageDirection('~~~\n```\nمرحبا\n~~~')).toBeUndefined();
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

  // Just inside an opening code span nothing can open a block: the span's text
  // is code, so removing the mark there cannot change how the line parses.
  it('strips a mark inside an opening code span that would otherwise open a block', () => {
    expect(withoutLeadingDirectionMarks('`\u200F# x`')).toBe('`# x`');
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

  // A paragraph that directly follows a line which ended its own block starts a
  // block of its own, so the mark in front of it names that block’s edge exactly
  // as it would after a blank line. Before this rule a marked Latin paragraph
  // under a heading kept the mark and laid out right to left, while the same
  // paragraph one blank line lower down did not.
  it.each([
    ['a heading', '# Heading\n\u200FLatin text'],
    ['a heading in a quote', '> # Heading\n\u200FLatin text'],
    ['a heading in a list item', '- # Heading\n\u200FLatin text'],
    ['a thematic break', '---\n\u200FLatin text'],
    ['a dash underline under paragraph text', 'Title\n---\n\u200FLatin text'],
    ['an equals underline under paragraph text', 'Title\n===\n\u200FLatin text'],
    ['a one-dash underline under paragraph text', 'Title\n-\n\u200FLatin text'],
    ['a two-dash underline under paragraph text', 'Title\n--\n\u200FLatin text'],
    ['an equals underline inside the same quote', '> Title\n>===\n\u200FLatin text'],
    // An underline under a list item's paragraph closes that paragraph only at
    // the item's own content indent: there `===` is inside the item and the line
    // under the heading starts a block of its own.
    ['an indented underline under a list item’s paragraph', '- Title\n  ===\n\u200FLatin text'],
    ['a fence that closed', '```js\nconst a = 1;\n```\n\u200FLatin text'],
    ['a reference definition', '[ref]: https://example.com\n\u200FLatin text'],
    ['an indented code line', '    code\n\u200FLatin text'],
    ['a code block of several indented lines', '    first\n    second\n\u200FLatin text'],
    ['a comment closed on its line', '<!-- c -->\n\u200FLatin text'],
    ['a processing instruction', '<?php echo 1; ?>\n\u200FLatin text'],
    ['a declaration', '<!DOCTYPE html>\n\u200FLatin text'],
    ['a pre element closed on its line', '<pre>a</pre>\n\u200FLatin text'],
    ['a script element closed on its line', '<script>a</script>\n\u200FLatin text'],
    ['a style element closed on its line', '<style>a{}</style>\n\u200FLatin text'],
    ['a textarea element closed on its line', '<textarea>a</textarea>\n\u200FLatin text'],
    ['a comment closed on a later line', '<!-- a\nb\n-->\n\u200FLatin text'],
    ['a processing instruction closed on a later line', '<?php\n?>\n\u200FLatin text'],
    ['a CDATA section closed on a later line', '<![CDATA[\nx\n]]>\n\u200FLatin text'],
    ['a pre element closed on a later line', '<pre>\nx\n</pre>\n\u200FLatin text'],
    ['a script element closed on a later line', '<script>\nx\n</script>\n\u200FLatin text'],
    // An HTML block's state belongs to the container it opened in: a blockquote
    // that ends under a block tag holds no more raw text, so the line below it is
    // a paragraph at top level and its mark names that paragraph's edge. The
    // renderer reads both shapes as a quote followed by a paragraph.
    ['a block tag whose quote ended', '> <div>\n> text\n\u200FLatin after'],
    ['a comment whose quote ended', '> <!-- c\n> more\n\u200FLatin after'],
    // A setext underline sits at its paragraph's container indent, which inside a
    // nested list item is four columns in: the underline closes the item's
    // paragraph there, and the line below it is the item's next block.
    ['an underline under a nested item’s paragraph', '- a\n  - Title\n    ===\n    \u200FLatin'],
  ])('strips a mark in the block that follows %s', (_shape, value) => {
    expect(withoutLeadingDirectionMarks(value)).toBe(value.replace('\u200F', ''));
  });

  // A line that ends nothing holds the block above it open: the line after it is
  // that block’s own continuation, whose mark orders the run it was written for.
  // An HTML block of the tag kinds runs to the next blank line, so the line under
  // it is still inside the block even though it starts with a tag.
  it.each([
    ['a paragraph continuation line', '\u200FFirst\n\u200Fsecond line', 'First\n\u200Fsecond line'],
    [
      'an indented paragraph continuation line',
      '\u200FFirst\n    \u200Fsecond line',
      'First\n    \u200Fsecond line',
    ],
    ['a list item continued lazily', '- item\n\u200FLatin text', '- item\n\u200FLatin text'],
    ['a quote continued lazily', '> quote\n\u200FLatin text', '> quote\n\u200FLatin text'],
    [
      'a block tag that runs to the next blank line',
      '<div>\n\u200FLatin text',
      '<div>\n\u200FLatin text',
    ],
    [
      'a complete tag that runs to the next blank line',
      '<a href="/x">\n\u200FLatin text',
      '<a href="/x">\n\u200FLatin text',
    ],
    [
      'a tag that closes inline but runs to the next blank line',
      '<div>x</div>\n\u200FLatin text',
      '<div>x</div>\n\u200FLatin text',
    ],
    // A setext underline cannot be a lazy continuation line of a list item, so
    // `===` at column zero under `- Title` is a paragraph line of its own and
    // the line under it is that paragraph's lazy continuation.
    [
      'an underline at column zero under a list item’s paragraph',
      '- Title\n===\n\u200FLatin text',
      '- Title\n===\n\u200FLatin text',
    ],
    // A definition cannot interrupt a paragraph, so inside one the definition
    // line is that paragraph’s own text and the line under it continues it.
    [
      'a reference definition inside a paragraph',
      'Text\n[ref]: https://example.com\n\u200FLatin text',
      'Text\n[ref]: https://example.com\n\u200FLatin text',
    ],
    // An HTML block of a terminator kind holds raw text until its own
    // terminator: a mark inside it is the block’s copy, and a blank line does
    // not end it.
    [
      'a comment that closes on a later line',
      '<!--\n\u200FLatin text\n-->',
      '<!--\n\u200FLatin text\n-->',
    ],
    [
      'a pre element across a blank line',
      '<pre>\n\n\u200FLatin text\n</pre>',
      '<pre>\n\n\u200FLatin text\n</pre>',
    ],
  ])('keeps a mark in %s', (_shape, value, expected) => {
    expect(withoutLeadingDirectionMarks(value)).toBe(expected);
  });

  // CommonMark's raw-text start condition is the tag name followed by
  // whitespace, `>`, or the end of the line, so a tag that merely begins with
  // one of those names opens no block. Read with a word boundary it did, and
  // since its `</script>` never arrives the block stayed open for the rest of
  // the message and every later block kept its mark.
  it('does not open a raw-text block on a tag name that only starts with one', () => {
    const value = 'Text\n<script-src x>\n# Heading\n\u200FLatin text';
    expect(withoutLeadingDirectionMarks(value)).toBe('Text\n<script-src x>\n# Heading\nLatin text');
  });

  // A CDATA section opens an HTML block of a terminator kind, so a mark in
  // front of its opener is refused like one in front of any other block:
  // stripped, it turns the paragraph into a raw block that renders nothing.
  it('keeps a mark in front of a CDATA section', () => {
    const value = '\u200F<![CDATA[x]]>';
    expect(withoutLeadingDirectionMarks(value)).toBe(value);
  });

  // A tag-kind HTML block — a known block tag, or one complete tag alone on its
  // line — has no terminator and runs to the next blank line. A `#` or a run of
  // dashes inside it is that block's copy, so the line under it is still raw
  // text and keeps its mark; only the line under the blank line opens a block.
  it('keeps a mark inside a tag-kind HTML block that holds markdown-shaped lines', () => {
    const heading = '<div>\n# not a heading\n\u200FLatin text';
    expect(withoutLeadingDirectionMarks(heading)).toBe(heading);
    const underline = '<div>\n===\n\u200FLatin text';
    expect(withoutLeadingDirectionMarks(underline)).toBe(underline);
    expect(withoutLeadingDirectionMarks('<div>\n\n\u200FLatin text')).toBe('<div>\n\nLatin text');
  });

  // A line can leave the container of a tag-kind HTML block and open another one
  // of its own: `<div>` at quote depth zero ends the quote that held the block
  // above it and opens a new block at the top level. A tag-kind block runs to the
  // next blank line, so the line under the new `<div>` is that block's raw text —
  // a `#` in front of it is part of the copy, not a heading — and its mark stays
  // with the copy. Only the paragraph under the blank line that ends the block
  // starts a block of its own.
  it('keeps a mark in the tag-kind block a line opens as it leaves a block’s container', () => {
    const text = '> <div>\n> text\n<div>\n\u200FLatin\n\n\u200FLatin after';
    expect(withoutLeadingDirectionMarks(text)).toBe(
      '> <div>\n> text\n<div>\n\u200FLatin\n\nLatin after'
    );
    const heading = '> <div>\n> text\n<div>\n# \u200FLatin\n\n\u200FLatin after';
    expect(withoutLeadingDirectionMarks(heading)).toBe(
      '> <div>\n> text\n<div>\n# \u200FLatin\n\nLatin after'
    );
  });

  // A quote opened at a list item's content column sits inside that item, and a
  // list item's content column does not move when a deeper quote opens in it: in
  // `  > quoted` under `- item` the `>` stands at the item's own column two and
  // the quote's text starts at column four. The blank line closes the quote while
  // the item stays open, so the marked line below is a paragraph at two columns
  // past the item's content start — paragraph text, not an indented code block
  // past column zero — and its mark names that paragraph's edge.
  it('holds a list item open through a quote opened inside it', () => {
    const value = '- item\n  > quoted\n\n    \u200FLatin';
    expect(withoutLeadingDirectionMarks(value)).toBe('- item\n  > quoted\n\n    Latin');
  });

  // A quote's own prefix is machinery, so the column a line reaches is read in
  // the list item's frame, past the quote markers the item sits under. `> quoted`
  // reaches column zero there, short of `- item`'s content column two: the item
  // ends on that line, so the marked line under the blank line is an indented
  // code block at the top level and keeps its mark. At the item's own column the
  // quote is inside the item, which stays open, and the line under the blank line
  // is a paragraph two columns past the item's content start, whose mark names
  // that paragraph's edge.
  it('ends a list item at a quote in column zero and holds it at the item’s column', () => {
    const outside = '- item\n> quoted\n\n    \u200FLatin';
    expect(withoutLeadingDirectionMarks(outside)).toBe(outside);
    expect(withoutLeadingDirectionMarks('- item\n  > quoted\n\n    \u200FLatin')).toBe(
      '- item\n  > quoted\n\n    Latin'
    );
  });

  // An indented code block is measured in the frame of the line's container, so a
  // quote's own prefix never passes for indentation. Two columns past a quote's
  // content start inside the item is a paragraph in the quote, and its mark names
  // that paragraph's edge; four columns is an indented code block, which keeps
  // every character it holds. Counted from column zero the prefix was the
  // difference, and the paragraph read as code.
  it('measures an indented code block past the quote prefix', () => {
    expect(withoutLeadingDirectionMarks('- item\n  > quoted\n\n  >   \u200FLatin')).toBe(
      '- item\n  > quoted\n\n  >   Latin'
    );
    const code = '- item\n  > quoted\n\n  >     \u200FLatin';
    expect(withoutLeadingDirectionMarks(code)).toBe(code);
  });

  // Only a known block tag, or one complete tag alone on its line, opens a
  // tag-kind block: an inline tag line is the paragraph's own text, a complete
  // tag cannot interrupt a paragraph, and a raw-text element's name belongs to
  // its terminator kind, whose start needs whitespace, `>` or the line's end.
  it('does not read an inline tag or a tag inside a paragraph as an HTML block', () => {
    expect(withoutLeadingDirectionMarks('<span>text\n# Heading\n\u200FLatin text')).toBe(
      '<span>text\n# Heading\nLatin text'
    );
    expect(withoutLeadingDirectionMarks('Text\n<a href="/x">\n# Heading\n\u200FLatin text')).toBe(
      'Text\n<a href="/x">\n# Heading\nLatin text'
    );
    expect(withoutLeadingDirectionMarks('<script/>\n# Heading\n\u200FLatin text')).toBe(
      '<script/>\n# Heading\nLatin text'
    );
  });

  // A setext underline closes the paragraph above it; a run of equals that starts
  // a block is that block’s own text, and the line under it continues it.
  it('keeps a mark under an equals run that has no paragraph above it', () => {
    const value = '===\n\u200FLatin text';
    expect(withoutLeadingDirectionMarks(value)).toBe(value);
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

  // A quote's prefix moves where the tab stops land, because CommonMark counts
  // them from the line's first column: behind `> ` the same padding reaches six
  // columns and leaves an indented code block, whose text keeps every character.
  // Unquoted the padding is three columns, so the `#` is a heading in the item.
  it('keeps a mark in a list item whose quoted tab padding makes an indented code block', () => {
    const code = '>-  \t# \u200FLatin';
    expect(withoutLeadingDirectionMarks(code)).toBe(code);
    expect(withoutLeadingDirectionMarks('-  \t# \u200FLatin')).toBe('-  \t# Latin');
  });

  // A tab inside the quote prefix moves the marker to a later column, so the
  // item's padding is narrower than its character count makes it look.
  it('counts a tab in the quote prefix as columns when placing the marker', () => {
    expect(withoutLeadingDirectionMarks('>\t-  \t# \u200FLatin')).toBe('>\t-  \t# Latin');
    const code = '>-  \t# \u200FLatin';
    expect(withoutLeadingDirectionMarks(code)).toBe(code);
  });

  // A checkbox is structure only at a list item's own content start, where
  // cutting the mark would turn `[ ]` into the item's task box. A paragraph's
  // brackets and space are its own text, so the mark there is only an edge.
  it('keeps a mark in front of a checkbox that would make the item a task', () => {
    const task = '- \u200F[ ] Latin';
    expect(withoutLeadingDirectionMarks(task)).toBe(task);
    expect(withoutLeadingDirectionMarks('\u200F[ ] Latin')).toBe('[ ] Latin');
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

  it('reports no pin for a value that leaves the direction open', () => {
    expect(pinsTextDirection({ direction: 'inherit' })).toBe(false);
    expect(pinsTextDirection({ writingDirection: 'auto' })).toBe(false);
  });

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

  it('turns the family ligatures off so a flag keeps its hyphens', () => {
    expect(codeFieldTextStyle().fontVariant).toEqual([
      'no-common-ligatures',
      'no-discretionary-ligatures',
      'no-contextual',
    ]);
  });
});
