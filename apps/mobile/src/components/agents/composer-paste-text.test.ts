import { describe, expect, it } from 'vitest';

import { insertPastedText } from './composer-paste-text';

describe('insertPastedText', () => {
  it('inserts at the caret and leaves the caret after the text', () => {
    const result = insertPastedText({
      draft: 'fix the bug',
      selection: { start: 4, end: 4 },
      text: 'really ',
      maxLength: 100,
    });

    expect(result.draft).toBe('fix really the bug');
    expect(result.caret).toBe(11);
  });

  it('replaces the selected range', () => {
    const result = insertPastedText({
      draft: 'fix the bug',
      selection: { start: 4, end: 7 },
      text: 'that',
      maxLength: 100,
    });

    expect(result.draft).toBe('fix that bug');
    expect(result.caret).toBe(8);
  });

  it('appends when no selection was reported', () => {
    const result = insertPastedText({
      draft: 'fix',
      selection: null,
      text: ' it',
      maxLength: 100,
    });

    expect(result.draft).toBe('fix it');
    expect(result.caret).toBe(6);
  });

  it('clamps a stale caret past the draft end to the end', () => {
    const result = insertPastedText({
      draft: 'fix',
      selection: { start: 40, end: 40 },
      text: '!',
      maxLength: 100,
    });

    expect(result.draft).toBe('fix!');
    expect(result.caret).toBe(4);
  });

  it('truncates the pasted text, never the existing draft', () => {
    const result = insertPastedText({
      draft: 'abcde',
      selection: { start: 2, end: 2 },
      text: 'XXXXX',
      maxLength: 7,
    });

    expect(result.draft).toBe('abXXcde');
    expect(result.caret).toBe(4);
  });

  it('keeps the draft untouched when the cap leaves no room', () => {
    const result = insertPastedText({
      draft: 'abcde',
      selection: { start: 2, end: 2 },
      text: 'XXXXX',
      maxLength: 5,
    });

    expect(result.draft).toBe('abcde');
    expect(result.caret).toBe(2);
  });
});
