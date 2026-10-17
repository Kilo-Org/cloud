import { describe, expect, it } from 'vitest';

import { convertHtmlToMarkdown } from './markdown-html-convert';

// A body of isolated code spans on lines that never go blank, the shape a
// pasted log or a generated listing has: one inline run holds every span, and
// the HTML around them converts the same way.
const HEAD = '<b>head</b> x< ';
const TAIL = '<b>tail</b>';

describe('convertHtmlToMarkdown on a body dense with code spans', () => {
  it('converts thousands of code spans within a time budget', () => {
    const value = `${HEAD}${'`a`b'.repeat(32_000)}${TAIL}`;
    const start = performance.now();
    const converted = convertHtmlToMarkdown(value);
    const elapsed = performance.now() - start;
    // The body is 128 KB and the scan is linear in it, so this budget leaves
    // two orders of magnitude of headroom on a loaded runner. Past its
    // code-span budget the scan stops looking and copies the rest verbatim,
    // which is why the tail keeps its tag here.
    expect(elapsed).toBeLessThan(750);
    expect(converted).toBe(`**head** x< ${'`a`b'.repeat(32_000)}${TAIL}`);
  });

  it('converts a short body of the same shape exactly', () => {
    expect(convertHtmlToMarkdown(`${HEAD}${'`a`b'.repeat(20)}${TAIL}`)).toBe(
      `**head** x< ${'`a`b'.repeat(20)}**tail**`
    );
  });

  it('keeps HTML parsing past the budget', () => {
    // The runs stay isolated so the 4097th span is inside the value, and the
    // emphasis around them still closes: the tail's close tag parses as markup
    // like the tail of any other body, instead of being copied into the
    // emphasis as text.
    const value = `<b>${'`x` '.repeat(4097)}</b>`;
    expect(convertHtmlToMarkdown(value)).toBe(`**${'`x` '.repeat(4097).trimEnd()}** `);
  });
});
