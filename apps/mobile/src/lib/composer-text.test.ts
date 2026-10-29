import { describe, expect, it } from 'vitest';

import { hasVisibleComposerText } from './composer-text';

describe('hasVisibleComposerText', () => {
  it.each([
    ['an empty value', ''],
    ['a single space', ' '],
    ['tabs, newlines and carriage returns', ' \t\n\r\v\f '],
    ['a no-break space and an ideographic space', '\u00A0\u3000'],
    ['line and paragraph separators', '\u2028\u2029'],
    ['a zero-width space', '\u200B'],
    ['zero-width joiners and a word joiner', '\u200C\u200D\u2060'],
    ['a byte-order mark', '\uFEFF'],
    ['a soft hyphen', '\u00AD'],
    ['directional marks', '\u200E\u200F\u061C'],
    ['bidi embeddings and isolates', '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069'],
    ['control characters', '\u0000\u0001\u001B\u007F\u0085'],
    ['a combining accent on its own', '\u0301'],
    ['a variation selector on its own', '\uFE0F'],
    ['hangul fillers', '\u115F\u1160\u3164\uFFA0'],
    ['a braille blank', '\u2800'],
    ['spaces mixed with zero-width and combining characters', '  \u200B\u00A0\u0301\u3000'],
  ])('treats %s as empty', (_case, value) => {
    expect(hasVisibleComposerText(value)).toBe(false);
  });

  it.each([
    ['a latin letter', 'a'],
    ['a latin letter with an accent', 'é'],
    ['cyrillic', 'Ж'],
    ['arabic', 'م'],
    ['han', '漢'],
    ['devanagari digits', '५'],
    ['a digit', '7'],
    ['punctuation alone', '?'],
    ['a symbol alone', '+'],
    ['a currency sign', '€'],
    ['an arrow', '→'],
    ['an emoji', '🎉'],
    ['an emoji newer than the engine classifies', '\u{1FAE9}'],
    ['one letter among blanks', ' \u200B\u00A0a\u3000'],
    ['one letter among fillers', '\u3164a\u2800'],
  ])('treats %s as text', (_case, value) => {
    expect(hasVisibleComposerText(value)).toBe(true);
  });
});
