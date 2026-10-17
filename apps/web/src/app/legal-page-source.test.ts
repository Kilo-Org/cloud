import { describe, expect, test } from '@jest/globals';

import { extractLegalMainHtml } from './legal-page-source';

const MISSING_MESSAGE = 'Could not find terms content.';

function extractMain(body: string): string {
  return extractLegalMainHtml({
    html: `<html><body><main>${body}</main></body></html>`,
    sourceUrl: 'https://kilo.ai/terms',
    missingMessage: MISSING_MESSAGE,
  });
}

const DROPPED_MARKUP_CASES: Array<[label: string, markup: string, expected: string]> = [
  ['a handler separated by a slash', '<svg/onload=alert(1)></svg>', ''],
  ['a handler on an unknown element', '<svg/onload=alert(document.cookie)>text</svg>', 'text'],
  ['an event handler attribute', `<h1 onclick="alert('xss')">Title</h1>`, '<h1>Title</h1>'],
  [
    'an image error handler',
    `<img src="/logo.png" onerror="alert('xss')">`,
    '<img src="https://kilo.ai/logo.png" />',
  ],
  ['a script element with a closing tag', `<script>alert('xss')</script>`, ''],
  ['a script element without a closing tag', `<script src="https://example.com/x.js">`, ''],
  ['an iframe element', `<iframe src="https://example.com"></iframe>`, ''],
  ['an object element', '<object data="https://example.com"></object>', ''],
  ['an embed element', '<embed src="https://example.com">', ''],
  ['a form element', '<form action="/x"><input name="y"></form>', ''],
  ['a base element', '<base href="https://evil.example/">', ''],
  [
    'a meta refresh element',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '',
  ],
  ['a style element', '<style>body{background:url(/x)}</style>', ''],
  ['a javascript: link', `<a href="javascript:alert(1)">click</a>`, '<a>click</a>'],
  ['a mixed-case javascript: link', `<a href="JaVaScRiPt:alert(1)">click</a>`, '<a>click</a>'],
  [
    'a tab-obfuscated javascript: link',
    '<a href="java\tscript:alert(1)">click</a>',
    '<a>click</a>',
  ],
  [
    'an entity-encoded javascript: link',
    `<a href="&#106;avascript:alert(1)">click</a>`,
    '<a>click</a>',
  ],
  [
    'a data: link',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
    '<a>click</a>',
  ],
  ['a data: image source', '<img src="data:image/svg+xml,<svg onload=alert(1)>">', '<img />'],
  ['a protocol-relative link', '<a href="//evil.example/x">click</a>', '<a>click</a>'],
  [
    'a source-only class attribute',
    '<div class="wrapper"><p>Body</p></div>',
    '<div><p>Body</p></div>',
  ],
  ['a source-only style attribute', '<p style="color:red">Body</p>', '<p>Body</p>'],
  ['a source-only data attribute', '<p data-sentry-component="Legal">Body</p>', '<p>Body</p>'],
];

describe('extractLegalMainHtml', () => {
  test('throws when the document has no main element', () => {
    expect(() =>
      extractLegalMainHtml({
        html: '<html><body><p>No main</p></body></html>',
        sourceUrl: 'https://kilo.ai/terms',
        missingMessage: MISSING_MESSAGE,
      })
    ).toThrow(MISSING_MESSAGE);
  });

  test('throws when only active markup remains', () => {
    expect(() =>
      extractMain('<script>alert(1)</script><iframe src="https://example.com"></iframe>')
    ).toThrow(MISSING_MESSAGE);
  });

  test.each(DROPPED_MARKUP_CASES)('drops %s', (_label, markup, expected) => {
    expect(extractMain(`<p>Body</p>${markup}`)).toBe(`<p>Body</p>${expected}`);
  });

  test('keeps ordinary legal content and source-only attributes stay out', () => {
    const result = extractMain(`
      <div class="wrapper" style="color:red" data-sentry-component="Legal">
        <h1 id="terms">Terms of Service</h1>
        <p>Read the <a href="/support" target="_blank" rel="noreferrer noopener">support policy</a>.</p>
        <p>Text with <strong>bold</strong>, <em>emphasis</em>, <code>code</code> and <sup>1</sup>.</p>
        <ul><li>One</li><li>Two</li></ul>
        <ol start="3"><li>Three</li></ol>
        <blockquote>Quoted terms</blockquote>
        <table><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td colspan="2">B</td></tr></tbody></table>
        <img src="/logo.png" alt="Logo">
      </div>
    `);

    expect(result).toContain('<h1 id="terms">Terms of Service</h1>');
    expect(result).toContain('href="https://kilo.ai/support"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noreferrer noopener"');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>emphasis</em>');
    expect(result).toContain('<code>code</code>');
    expect(result).toContain('<sup>1</sup>');
    expect(result).toContain('<ul><li>One</li><li>Two</li></ul>');
    expect(result).toContain('<ol start="3"><li>Three</li></ol>');
    expect(result).toContain('<blockquote>Quoted terms</blockquote>');
    expect(result).toContain('<th scope="col">A</th>');
    expect(result).toContain('<td colspan="2">B</td>');
    expect(result).toContain('<img src="https://kilo.ai/logo.png" alt="Logo" />');
    expect(result).not.toContain('class=');
    expect(result).not.toContain('style=');
    expect(result).not.toContain('data-sentry');
  });

  test('keeps entity text readable', () => {
    expect(extractMain('<p>a &amp; b &lt;tag&gt;</p>')).toBe('<p>a &amp; b &lt;tag&gt;</p>');
  });

  test('pairs new-tab links with the site-wide rel convention', () => {
    expect(extractMain('<a href="/x" target="_blank">one</a>')).toBe(
      '<a href="https://kilo.ai/x" target="_blank" rel="noopener noreferrer">one</a>'
    );
    expect(extractMain('<a href="/y" target="_blank" rel="nofollow">two</a>')).toBe(
      '<a href="https://kilo.ai/y" target="_blank" rel="nofollow noopener noreferrer">two</a>'
    );
    expect(extractMain('<a href="/z">three</a>')).toBe('<a href="https://kilo.ai/z">three</a>');
  });
});
