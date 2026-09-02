import { extractSearchUrls } from './tool-search';

const parenthesizedUrls = [
  'https://en.wikipedia.org/wiki/Rust_(programming_language)',
  'https://example.com/docs/function(arg(nested))',
  'https://example.com/docs/(outer(inner))/next',
  'https://example.com/search?q=(outer(inner))',
  'https://example.com/search?q=(outer(inner))&lang=rust',
  'https://example.com/(one(two(three)))/find?q=(alpha(beta))#section',
];

describe('extractSearchUrls', () => {
  it.each(parenthesizedUrls)('preserves balanced and nested URL parentheses: %s', url => {
    expect(extractSearchUrls(url)).toEqual([url]);
  });

  it.each(parenthesizedUrls)(
    'separates URL parentheses from Markdown and prose wrappers: %s',
    url => {
      expect(extractSearchUrls(`[result](${url}), <${url}> \`${url}\` (${url}). ${url}!?`)).toEqual(
        [url]
      );
    }
  );
  it('extracts native, Markdown, and plain-text links in output order', () => {
    const output = [
      'Title: A result',
      'URL: https://example.com/docs',
      '[Another result](https://example.org/api?q=tools&limit=2)',
      'See <http://localhost:3000/readme> and `https://example.net/code`.',
    ].join('\n');

    expect(extractSearchUrls(output)).toEqual([
      'https://example.com/docs',
      'https://example.org/api?q=tools&limit=2',
      'http://localhost:3000/readme',
      'https://example.net/code',
    ]);
  });

  it('removes trailing prose punctuation and deduplicates repeated links', () => {
    expect(
      extractSearchUrls(
        'https://example.com/docs, https://example.com/docs. [docs](https://example.com/docs) https://example.org/api!?'
      )
    ).toEqual(['https://example.com/docs', 'https://example.org/api']);
  });

  it('keeps query parameters and fragments intact', () => {
    expect(extractSearchUrls('https://example.com/search?q=a%20b&lang=ts#results')).toEqual([
      'https://example.com/search?q=a%20b&lang=ts#results',
    ]);
  });

  it('accepts case-insensitive HTTP schemes', () => {
    expect(extractSearchUrls('HTTPS://example.com/docs')).toEqual(['HTTPS://example.com/docs']);
  });

  it.each([
    undefined,
    '',
    ' \n ',
    'No results found',
    'javascript:alert(1) data:text/html,<script>alert(1)</script> file:///etc/passwd',
    'ftp://example.com/file //example.com/relative /local/path',
    'mailto:someone@example.com tel:1234567890 custom://example.com',
    'example.com www.example.org someone@example.com 127.0.0.1',
    'https:// https://? https://# https://%invalid',
  ])('returns no links for empty, unsafe, or invalid output: %s', output => {
    expect(extractSearchUrls(output)).toEqual([]);
  });
});
