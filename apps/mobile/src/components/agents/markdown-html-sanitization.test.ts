import { describe, expect, it } from 'vitest';

import { htmlSanitizesToEmpty } from './markdown-html-sanitization';

describe('htmlSanitizesToEmpty', () => {
  it('is true for whitespace-only text with no HTML', () => {
    expect(htmlSanitizesToEmpty('')).toBe(true);
    expect(htmlSanitizesToEmpty('  \n\t ')).toBe(true);
  });

  it('is false for ordinary streamed text with no HTML', () => {
    expect(htmlSanitizesToEmpty('thinking through the plan')).toBe(false);
  });

  it('is true for a removed element holding all the text', () => {
    expect(htmlSanitizesToEmpty('<style>.x{}</style>')).toBe(true);
    expect(htmlSanitizesToEmpty('<script>alert(1)</script>')).toBe(true);
    expect(htmlSanitizesToEmpty('<!-- comment only -->')).toBe(true);
  });

  it('is false when text survives the removals', () => {
    expect(htmlSanitizesToEmpty('<b>bold</b>')).toBe(false);
    expect(htmlSanitizesToEmpty('<style>.x{}</style>visible')).toBe(false);
  });

  it('agrees with the slow path across mixed streamed chunks', () => {
    // Fast path (no '<'): there is no HTML to remove, so the predicate is
    // exactly "the chunk holds only whitespace".
    for (const chunk of ['plain reasoning', 'ampersand & entity &amp;', '', '   ']) {
      expect(htmlSanitizesToEmpty(chunk)).toBe(chunk.trim() === '');
    }
    // Slow path (with '<'): only a chunk the removals empty out is true.
    const htmlChunks: [text: string, sanitizesToEmpty: boolean][] = [
      ['<b>bold reasoning', false],
      ['</b>', false],
      ['trailing <', false],
      ['<div></div>', true],
    ];
    for (const [chunk, sanitizesToEmpty] of htmlChunks) {
      expect(htmlSanitizesToEmpty(chunk)).toBe(sanitizesToEmpty);
    }
  });
});
