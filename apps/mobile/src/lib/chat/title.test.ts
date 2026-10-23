import { describe, expect, it } from 'vitest';

import { DERIVED_CHAT_TEXT_MAX_LENGTH, derivedChatText } from './title';

/** The label a message of `count` repeated graphemes becomes: the cut, then the ellipsis. */
const cutTo = (grapheme: string, count: number) => `${grapheme.repeat(count)}…`;

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
