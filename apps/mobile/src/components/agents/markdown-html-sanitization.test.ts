import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearHtmlEmptinessCacheForTests,
  htmlSanitizesToEmpty,
} from './markdown-html-sanitization';

/** All-white nesting `depth` levels deep, with one text leaf inside. */
function nestedEmptyContainers(depth: number): string {
  return `${'<div>'.repeat(depth)}   ${'</div>'.repeat(depth)}`;
}

const replacesOf = (value: string) => {
  const spy = vi.spyOn(String.prototype, 'replace');
  htmlSanitizesToEmpty(value);
  const calls = spy.mock.calls.length;
  spy.mockRestore();
  return calls;
};

beforeEach(() => {
  clearHtmlEmptinessCacheForTests();
});

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

  it('collapses nested emptied containers', () => {
    expect(htmlSanitizesToEmpty(nestedEmptyContainers(4))).toBe(true);
    expect(htmlSanitizesToEmpty(`<div><span></span></div>`)).toBe(true);
  });

  it('reports nesting past the pass bound as visible instead of looping', () => {
    // Each pass only collapses the innermost emptied element, so a value nests
    // deeper than the bound still changes on its last pass. The answer then has
    // to be "visible": the part renders, which is the direction that cannot hide
    // a message.
    expect(htmlSanitizesToEmpty(nestedEmptyContainers(200))).toBe(false);
  });

  it('bounds the passes over one value independently of its nesting depth', () => {
    // Regression: the loop ran to a fixpoint, so each pass re-replaced the whole
    // value and a deeply nested one cost depth × length on the JS thread — on
    // every streamed publish. One pass is four replaces; the bound is eight.
    const shallow = replacesOf(nestedEmptyContainers(1));
    const deep = replacesOf(nestedEmptyContainers(200));
    expect(shallow).toBe(8);
    expect(deep).toBe(32);
  });

  it('answers a repeated value from the memo', () => {
    // The transcript rebuilds ask about the same part text again on every
    // publish; the answer is pure, so only the first ask pays for the removals.
    const value = '<div><span></span></div>';
    expect(htmlSanitizesToEmpty(value)).toBe(true);
    expect(replacesOf(value)).toBe(0);
  });

  it('memoizes the visible answer too', () => {
    const value = '<b>bold</b>';
    expect(htmlSanitizesToEmpty(value)).toBe(false);
    expect(replacesOf(value)).toBe(0);
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
        // Every '<'-chunk above keeps non-whitespace text after the removals,
        // so the slow path must report visible content.
        expect(htmlSanitizesToEmpty(chunk)).toBe(false);
      }
    }
  });
});
