import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMarkdownParseCachesForTests } from '@/components/agents/markdown-parse-cache';
import type * as MarkdownParseCache from '@/components/agents/markdown-parse-cache';
import {
  DERIVED_CHAT_TEXT_MAX_LENGTH,
  DERIVED_CHAT_TEXT_SOURCE_WINDOW,
  derivedChatText,
} from './title';

// The lengths `derivedChatText` hands the lexer, in order. `vi.mock` factories
// are hoisted above this file's imports, so the recorder lives in a hoisted
// object the factory can reach.
const lexedLengths = vi.hoisted(() => [] as number[]);

vi.mock('@/components/agents/markdown-parse-cache', async () => {
  const actual = await vi.importActual<typeof MarkdownParseCache>(
    '@/components/agents/markdown-parse-cache'
  );
  return {
    ...actual,
    lexMarkdown: (value: string) => {
      lexedLengths.push(value.length);
      return actual.lexMarkdown(value);
    },
  };
});

/** The label a message of `count` repeated graphemes becomes: the cut, then the ellipsis. */
const cutTo = (grapheme: string, count: number) => `${grapheme.repeat(count)}…`;

beforeEach(() => {
  lexedLengths.length = 0;
  clearMarkdownParseCachesForTests();
});

describe('derivedChatText', () => {
  it('leaves a short message as the one line it already is', () => {
    expect(derivedChatText('what is a monad')).toBe('what is a monad');
  });

  it('flattens line breaks, tabs and repeated spaces into single spaces', () => {
    expect(derivedChatText('  first line\n\nsecond\tline   with   spaces  ')).toBe(
      'first line second line with spaces'
    );
  });

  it('answers empty for a message with nothing but whitespace', () => {
    expect(derivedChatText(' \n\t ')).toBe('');
  });

  it('keeps a message that is exactly the cap, with no ellipsis', () => {
    const text = 'x'.repeat(DERIVED_CHAT_TEXT_MAX_LENGTH);

    expect(derivedChatText(text)).toBe(text);
  });

  it('keeps a message that fits the cap in characters but not in code units', () => {
    // Well inside the cap in characters, far past it in UTF-16 units: it still
    // fits, so no ellipsis belongs on it. A family is eleven units, so forty of
    // them are four hundred and forty against a cap of eighty.
    const families = '👨‍👩‍👧‍👦'.repeat(40);
    // Forty-one characters are eighty-two units: past the cap only in units.
    const stacked = '😀'.repeat(41);

    expect(families.length).toBeGreaterThan(DERIVED_CHAT_TEXT_MAX_LENGTH);
    expect(stacked.length).toBeGreaterThan(DERIVED_CHAT_TEXT_MAX_LENGTH);
    expect(derivedChatText(families)).toBe(families);
    expect(derivedChatText(stacked)).toBe(stacked);
  });

  it('adds the ellipsis only once the characters themselves run past the cap', () => {
    const justFits = '😀'.repeat(DERIVED_CHAT_TEXT_MAX_LENGTH);
    const justOver = '😀'.repeat(DERIVED_CHAT_TEXT_MAX_LENGTH + 1);

    expect(derivedChatText(justFits)).toBe(justFits);
    expect(derivedChatText(justOver)).toBe(cutTo('😀', DERIVED_CHAT_TEXT_MAX_LENGTH - 1));
  });

  it('cuts a longer message at the cap and marks the cut with an ellipsis', () => {
    const derived = derivedChatText('word '.repeat(2_000));

    expect(derived).toHaveLength(DERIVED_CHAT_TEXT_MAX_LENGTH);
    expect(derived.endsWith('…')).toBe(true);
    // The word boundary the cut fell on keeps its space out of the label.
    expect(derived.endsWith(' …')).toBe(false);
  });

  it('never splits a character the reader sees as one', () => {
    // A family is four code points joined by three zero-width joiners.
    expect(derivedChatText('👨‍👩‍👧‍👦'.repeat(200))).toBe(cutTo('👨‍👩‍👧‍👦', DERIVED_CHAT_TEXT_MAX_LENGTH - 1));
    // A syllable and its vowel sign are one grapheme and two code points.
    expect(derivedChatText('चै'.repeat(200))).toBe(cutTo('चै', DERIVED_CHAT_TEXT_MAX_LENGTH - 1));
  });

  it('counts a digit outside the BMP as one character', () => {
    expect(derivedChatText('😀'.repeat(200))).toBe(cutTo('😀', DERIVED_CHAT_TEXT_MAX_LENGTH - 1));
  });
});

describe('derivedChatText over a message longer than the source window', () => {
  it('reads at most the window and labels from its start, not from the whole body', () => {
    const body = 'tell me about the composer '.repeat(2_000);
    expect(body.length).toBeGreaterThan(DERIVED_CHAT_TEXT_SOURCE_WINDOW);

    const derived = derivedChatText(body);

    expect(lexedLengths.length).toBeGreaterThan(0);
    // The window, plus the one code unit that keeps a surrogate pair whole.
    expect(Math.max(...lexedLengths)).toBeLessThanOrEqual(DERIVED_CHAT_TEXT_SOURCE_WINDOW + 1);
    expect(derived).toHaveLength(DERIVED_CHAT_TEXT_MAX_LENGTH);
    expect(derived.endsWith('…')).toBe(true);
    expect(derived.startsWith('tell me about the composer')).toBe(true);
    // The same label the window alone produces: the rest of the body is never read.
    expect(derived).toBe(derivedChatText(body.slice(0, DERIVED_CHAT_TEXT_SOURCE_WINDOW)));
  });

  it('keeps a digit outside the BMP whole when the window ends on its first half', () => {
    // The window's last code unit is the high half of a surrogate pair, and the
    // visible text inside it fits the cap, so the pair decides the whole label.
    const body = `${' '.repeat(DERIVED_CHAT_TEXT_SOURCE_WINDOW - 1)}😀tail`;

    expect(derivedChatText(body)).toBe('😀');
  });

  it('hands a short message to the lexer unchanged', () => {
    const body = 'short and sweet';

    expect(derivedChatText(body)).toBe(body);
    expect(lexedLengths).toEqual([body.length]);
  });

  it('labels a body whose window is whitespace as empty, which is the accepted degradation', () => {
    // The window holds the first 4,096 code units, all blanks here, so the
    // words past it are never read. A label costs the label, not the body.
    const body = `${' '.repeat(5_000)}late words`;

    expect(derivedChatText(body)).toBe('');
  });
});

describe('derivedChatText with inline markdown', () => {
  it('reduces strong text to the words it wraps', () => {
    expect(derivedChatText("That's the classic **Lorem ipsum** placeholder text")).toBe(
      "That's the classic Lorem ipsum placeholder text"
    );
    expect(derivedChatText('__strong__')).toBe('strong');
  });

  it('reduces emphasis to the word it wraps', () => {
    expect(derivedChatText('*em*')).toBe('em');
    expect(derivedChatText('_em_')).toBe('em');
  });

  it('reduces inline code to its content', () => {
    expect(derivedChatText('run `code` now')).toBe('run code now');
  });

  it('reduces strikethrough to the word it wraps', () => {
    expect(derivedChatText('~~gone~~')).toBe('gone');
  });

  it('keeps a link label and drops its destination', () => {
    expect(derivedChatText('see [the docs](https://example.com/x)')).toBe('see the docs');
  });

  it('keeps an image alt text and drops its source', () => {
    expect(derivedChatText('![a diagram](https://example.com/a.png)')).toBe('a diagram');
  });

  it('leaves arithmetic and identifiers alone', () => {
    expect(derivedChatText('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(derivedChatText('snake_case_name')).toBe('snake_case_name');
  });

  it('leaves an unmatched marker alone', () => {
    expect(derivedChatText('an unmatched * here')).toBe('an unmatched * here');
  });

  it('drops the backslash of an escape and keeps the character it escaped', () => {
    expect(derivedChatText(String.raw`\*literal\*`)).toBe('*literal*');
  });

  it('answers empty for a body that is nothing but markup', () => {
    expect(derivedChatText('---')).toBe('');
  });

  it('caps a long emphasized body at the plain-text length', () => {
    const derived = derivedChatText('**ipsum** '.repeat(40));

    expect(derived).toHaveLength(DERIVED_CHAT_TEXT_MAX_LENGTH);
    expect(derived.endsWith('…')).toBe(true);
    expect(derived.includes('*')).toBe(false);
  });

  it('collapses whitespace around the markdown it reduced', () => {
    expect(derivedChatText('  **first**   line\n\nsecond\t`line`  ')).toBe(
      'first line second line'
    );
  });

  it('keeps a heading, a quote, and list items from running into each other', () => {
    expect(derivedChatText('# Release\n\nchecklist for the app')).toBe(
      'Release checklist for the app'
    );
    expect(derivedChatText('- one\n- two')).toBe('one two');
    expect(derivedChatText('1. Bump the version\n2. Build the bundle\n3. Upload')).toBe(
      'Bump the version Build the bundle Upload'
    );
    expect(derivedChatText('> quoted line\n\nnext paragraph')).toBe('quoted line next paragraph');
  });

  it('keeps table cells apart', () => {
    expect(derivedChatText('x | y\n--- | ---\n1 | 2')).toBe('x y 1 2');
  });

  it('separates the words around an inline html break', () => {
    expect(derivedChatText('one<br>two')).toBe('one two');
  });

  it('keeps the visible text of an html block', () => {
    expect(derivedChatText('<p>deploy failed</p>')).toBe('deploy failed');
  });

  it('keeps only the text of a tag with an attribute', () => {
    expect(derivedChatText('<span class="x">hi</span>')).toBe('hi');
  });

  it('keeps the items of a nested list apart', () => {
    expect(derivedChatText('- parent\n  - child\n- second')).toBe('parent child second');
  });
});
