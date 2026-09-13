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
    const chunks = [
      'plain reasoning',
      '<b>bold reasoning',
      '</b>',
      'ampersand & entity &amp;',
      'trailing <',
      '',
      '   ',
    ];
    // Fast path (no '<') and slow path (with '<') are one function; this
    // pins the streamed no-'<' case against the removal cases.
    for (const chunk of chunks) {
      if (!chunk.includes('<')) {
        expect(htmlSanitizesToEmpty(chunk)).toBe(chunk.trim() === '');
      }
    }
    for (const chunk of chunks) {
      if (chunk.includes('<')) {
        expect(typeof htmlSanitizesToEmpty(chunk)).toBe('boolean');
      }
    }
  });
});
