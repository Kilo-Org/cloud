import { describe, expect, it } from 'vitest';
import { sanitizeTabContextText, sanitizeTabContextUrl } from './tab-context-sanitize';

describe('tab context text sanitizing', () => {
  it('escapes ampersand before angle brackets so entities are not double-escaped', () => {
    expect(sanitizeTabContextText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(sanitizeTabContextText('&lt;already&gt;')).toBe('&amp;lt;already&amp;gt;');
  });

  it('leaves plain text unchanged', () => {
    expect(sanitizeTabContextText('plain title')).toBe('plain title');
  });
});

describe('tab context URL sanitizing', () => {
  it('strips query and hash while preserving origin and path', () => {
    expect(sanitizeTabContextUrl('https://example.com/path?q=1#section')).toBe(
      'https://example.com/path'
    );
  });

  it('returns the invalid-URL fallback when parsing fails', () => {
    expect(sanitizeTabContextUrl('not a url')).toBe('[invalid URL]');
    expect(sanitizeTabContextUrl('')).toBe('[invalid URL]');
  });
});
