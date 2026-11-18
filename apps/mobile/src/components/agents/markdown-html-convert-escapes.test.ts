import { marked } from 'marked';
import { describe, expect, it } from 'vitest';

import { convertHtmlToMarkdown } from './markdown-html-convert';

describe('convertHtmlToMarkdown literal text', () => {
  it('escapes markdown syntax in text copied out of HTML', () => {
    expect(convertHtmlToMarkdown('<p>a*b*c</p>')).toBe(String.raw`a\*b\*c`);
    expect(convertHtmlToMarkdown('<p>[x](https://example.com)</p>')).toBe(
      String.raw`\[x\](https://example.com)`
    );
    expect(convertHtmlToMarkdown('<p>snake_case ~~gone~~</p>')).toBe(
      String.raw`snake\_case \~\~gone\~\~`
    );
    expect(convertHtmlToMarkdown(String.raw`<p>path \* x</p>`)).toBe(String.raw`path \\\* x`);
    expect(convertHtmlToMarkdown('<p>5 < 6</p>')).toBe(String.raw`5 \< 6`);
  });

  it('escapes the text around the delimiters it generates', () => {
    expect(convertHtmlToMarkdown('<p><em>a*b</em></p>')).toBe(String.raw`*a\*b*`);
    expect(convertHtmlToMarkdown('<p><b>snake_case</b></p>')).toBe(String.raw`**snake\_case**`);
    expect(convertHtmlToMarkdown('<h1>C *draft* #</h1>')).toBe(String.raw`# C \*draft\* \#`);
  });

  it('keeps a code span the source already wrote in markdown', () => {
    expect(convertHtmlToMarkdown('<p>run `pnpm build` now</p>')).toBe('run `pnpm build` now');
  });

  it('leaves a bare URL or address as the link the renderer makes of it', () => {
    expect(convertHtmlToMarkdown('<p>see https://x.dev/a_b</p>')).toBe('see https://x.dev/a_b');
    expect(convertHtmlToMarkdown('<p>mail first_last@example.com</p>')).toBe(
      'mail first_last@example.com'
    );
    // Text around the run still escapes.
    expect(convertHtmlToMarkdown('<p>_x_ see https://x.dev/a_b</p>')).toBe(
      String.raw`\_x\_ see https://x.dev/a_b`
    );
  });

  it('renders escaped text as the characters the source HTML held', () => {
    // The round trip through the transcript's own renderer: literal text stays
    // literal, and the elements markdown can express still parse as syntax.
    for (const [html, rendered] of [
      ['<p>a*b*c</p>', 'a*b*c'],
      ['<p>snake_case</p>', 'snake_case'],
      ['<p>~~gone~~</p>', '~~gone~~'],
      ['<p>5 &lt; 6</p>', '5 &lt; 6'],
      ['<p>https://x.dev/a_b</p>', '<a href="https://x.dev/a_b">https://x.dev/a_b</a>'],
      [
        '<p>first_last@example.com</p>',
        '<a href="mailto:first_last@example.com">first_last@example.com</a>',
      ],
      [
        '<p>real <em>em</em> <code>c</code> <a href="https://example.com">link</a></p>',
        'real <em>em</em> <code>c</code> <a href="https://example.com">link</a>',
      ],
    ] as const) {
      expect(marked.parseInline(convertHtmlToMarkdown(html))).toBe(rendered);
    }
  });
});
