import { describe, expect, it } from 'vitest';

import {
  decidePrLinkOpen,
  decidePrLinkPaste,
  prLinkToastClipboardEmptyCopy,
  prLinkToastInvalidCopy,
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

  it('returns valid-pr-url for a gitlab.com merge request', () => {
    const url = 'https://gitlab.com/group/sub/repo/-/merge_requests/123';
    expect(decidePrLinkPaste(url)).toEqual({ kind: 'valid-pr-url', text: url });
  });

  it('returns valid-pr-url for a self-managed GitLab host, legacy form included', () => {
    expect(
      decidePrLinkPaste('https://gitlab.example.com/acme/api/-/merge_requests/9/diffs')
    ).toEqual({
      kind: 'valid-pr-url',
      text: 'https://gitlab.example.com/acme/api/-/merge_requests/9/diffs',
    });
    expect(decidePrLinkPaste('https://gitlab.example.com/acme/api/merge_requests/9')).toEqual({
      kind: 'valid-pr-url',
      text: 'https://gitlab.example.com/acme/api/merge_requests/9',
    });
  });

  it('returns valid-pr-url for a Bitbucket pull request, overview variant included', () => {
    expect(decidePrLinkPaste('https://bitbucket.org/acme/api/pull-requests/42')).toEqual({
      kind: 'valid-pr-url',
      text: 'https://bitbucket.org/acme/api/pull-requests/42',
    });
    expect(
      decidePrLinkPaste('https://bitbucket.org/acme/api/pull-requests/42/overview?tab=commits')
    ).toEqual({
      kind: 'valid-pr-url',
      text: 'https://bitbucket.org/acme/api/pull-requests/42/overview?tab=commits',
    });
  });

  it('returns non-url-text with trimmed text for non-review content', () => {
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
    expect(decidePrLinkPaste('https://bitbucket.org/acme/api/pull-requests/abc')).toEqual({
      kind: 'non-url-text',
      text: 'https://bitbucket.org/acme/api/pull-requests/abc',
    });
  });
});

describe('decidePrLinkOpen', () => {
  it('returns the GitHub ref for a github.com PR link', () => {
    expect(decidePrLinkOpen('https://github.com/octocat/hello-world/pull/42')).toEqual({
      kind: 'open',
      ref: { platform: 'github', owner: 'octocat', repo: 'hello-world', number: 42 },
    });
  });

  it('returns the GitLab ref with the pasted origin as instanceHint', () => {
    expect(
      decidePrLinkOpen('  https://gitlab.example.com/group/sub/repo/-/merge_requests/7#note_1 ')
    ).toEqual({
      kind: 'open',
      ref: {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        mrIid: 7,
        instanceHint: 'https://gitlab.example.com',
      },
    });
  });

  it('returns the Bitbucket ref for a pull request link', () => {
    expect(decidePrLinkOpen('https://bitbucket.org/acme/api/pull-requests/42')).toEqual({
      kind: 'open',
      ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 },
    });
  });

  it('returns invalid for anything no provider serves', () => {
    expect(decidePrLinkOpen('hello')).toEqual({ kind: 'invalid' });
    expect(decidePrLinkOpen('https://github.example.com/o/r/pull/1')).toEqual({ kind: 'invalid' });
    expect(decidePrLinkOpen('')).toEqual({ kind: 'invalid' });
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
    expect(prLinkToastClipboardEmptyCopy()).toBe('Clipboard is empty');
    expect(prLinkToastInvalidCopy()).toBe('Not a pull request or merge request link');
  });
});
