import { describe, expect, it } from 'vitest';

import { decidePrLinkPaste } from './pr-link-paste';

describe('decidePrLinkPaste', () => {
  it('returns empty for null, undefined, blank, and whitespace-only clipboard', () => {
    expect(decidePrLinkPaste(null)).toEqual({ kind: 'empty' });
    expect(decidePrLinkPaste(undefined)).toEqual({ kind: 'empty' });
    expect(decidePrLinkPaste('')).toEqual({ kind: 'empty' });
    expect(decidePrLinkPaste('   \n\t  ')).toEqual({ kind: 'empty' });
  });

  it('returns valid-pr-url with trimmed text for a GitHub PR link', () => {
    const url = 'https://github.com/octocat/hello-world/pull/42';
    expect(decidePrLinkPaste(`  ${url}  `)).toEqual({
      kind: 'valid-pr-url',
      text: url,
    });
  });

  it('returns valid-pr-url for PR URLs with subpaths and query strings', () => {
    const url = 'https://github.com/octocat/hello-world/pull/42/files?diff=split';
    expect(decidePrLinkPaste(url)).toEqual({
      kind: 'valid-pr-url',
      text: url,
    });
  });

  it('returns non-url-text with trimmed text for non-PR content', () => {
    expect(decidePrLinkPaste('  not a url  ')).toEqual({
      kind: 'non-url-text',
      text: 'not a url',
    });
    expect(decidePrLinkPaste('https://github.com/octocat/hello-world/issues/1')).toEqual({
      kind: 'non-url-text',
      text: 'https://github.com/octocat/hello-world/issues/1',
    });
    expect(decidePrLinkPaste('https://gitlab.com/o/r/pull/1')).toEqual({
      kind: 'non-url-text',
      text: 'https://gitlab.com/o/r/pull/1',
    });
  });
});
