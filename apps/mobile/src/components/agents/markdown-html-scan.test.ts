import { describe, expect, it } from 'vitest';

import { convertHtmlToMarkdown } from './markdown-html-convert';

const HEAD = '<b>head</b> x< ';
const TAIL = '<b>tail</b>';

describe('convertHtmlToMarkdown generated fixtures', () => {
  it('completes the large fixture within its processing budget', () => {
    const value = `${HEAD}${'`a`b'.repeat(32_000)}${TAIL}`;
    const start = performance.now();
    const converted = convertHtmlToMarkdown(value);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(750);
    expect(converted).toBe(`**head** x< ${'`a`b'.repeat(32_000)}${TAIL}`);
  });

  it('converts the short fixture exactly', () => {
    expect(convertHtmlToMarkdown(`${HEAD}${'`a`b'.repeat(20)}${TAIL}`)).toBe(
      `**head** x< ${'`a`b'.repeat(20)}**tail**`
    );
  });

  it('preserves closing emphasis in the generated fixture', () => {
    const value = `<b>${'`x` '.repeat(4097)}</b>`;
    expect(convertHtmlToMarkdown(value)).toBe(`**${'`x` '.repeat(4097).trimEnd()}** `);
  });
});
