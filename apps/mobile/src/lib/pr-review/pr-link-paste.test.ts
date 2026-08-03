import { describe, expect, it } from 'vitest';

import {
  decidePrLinkPaste,
  PR_LINK_TOAST_CLIPBOARD_EMPTY_COPY,
  PR_LINK_TOAST_INVALID_COPY,
  selectPrLinkClearButtonVisible,
} from './pr-link-paste';

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

describe('selectPrLinkClearButtonVisible', () => {
  it('is present when the field has content', () => {
    expect(selectPrLinkClearButtonVisible({ hasInput: true })).toBe(true);
  });

  it('is absent when the field is empty', () => {
    expect(selectPrLinkClearButtonVisible({ hasInput: false })).toBe(false);
  });
});

describe('PR link toast copy', () => {
  it('exports the pinned toast copy strings', () => {
    expect(PR_LINK_TOAST_CLIPBOARD_EMPTY_COPY).toBe('Clipboard is empty');
    expect(PR_LINK_TOAST_INVALID_COPY).toBe('Not a GitHub pull request link');
  });
});
