import { describe, expect, it } from 'vitest';

import { parseGitHubPrUrl } from './github-pr-url';

describe('parseGitHubPrUrl', () => {
  it('parses a canonical PR URL', () => {
    expect(parseGitHubPrUrl('https://github.com/octocat/hello-world/pull/42')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('parses a PR URL with the /files subpath', () => {
    expect(parseGitHubPrUrl('https://github.com/octocat/hello-world/pull/42/files')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('parses a PR URL with a query string', () => {
    expect(parseGitHubPrUrl('https://github.com/octocat/hello-world/pull/42?diff=split')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('parses a PR URL with a trailing slash', () => {
    expect(parseGitHubPrUrl('https://github.com/octocat/hello-world/pull/42/')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('parses http URLs', () => {
    expect(parseGitHubPrUrl('http://github.com/octocat/hello-world/pull/1')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 1,
    });
  });

  it('parses www.github.com host', () => {
    expect(parseGitHubPrUrl('https://www.github.com/octocat/hello-world/pull/7')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 7,
    });
  });

  it('parses a PR URL with a hash fragment', () => {
    expect(
      parseGitHubPrUrl('https://github.com/octocat/hello-world/pull/42#discussion_r1')
    ).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('returns null for an issue URL', () => {
    expect(parseGitHubPrUrl('https://github.com/octocat/hello-world/issues/42')).toBeNull();
  });

  it('returns null for a tree URL', () => {
    expect(parseGitHubPrUrl('https://github.com/octocat/hello-world/tree/main')).toBeNull();
  });

  it('returns null for a plain repo URL', () => {
    expect(parseGitHubPrUrl('https://github.com/octocat/hello-world')).toBeNull();
  });

  it('returns null for a non-GitHub host', () => {
    expect(parseGitHubPrUrl('https://gitlab.com/octocat/hello-world/pull/42')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(parseGitHubPrUrl('not a url at all')).toBeNull();
  });

  it('returns null for a PR URL with a non-numeric number', () => {
    expect(parseGitHubPrUrl('https://github.com/octocat/hello-world/pull/abc')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseGitHubPrUrl('')).toBeNull();
  });

  it('rejects owner or repo composed solely of dots', () => {
    expect(parseGitHubPrUrl('https://github.com/./repo/pull/5')).toBeNull();
    expect(parseGitHubPrUrl('https://github.com/owner/./pull/5')).toBeNull();
    expect(parseGitHubPrUrl('https://github.com/../repo/pull/5')).toBeNull();
    expect(parseGitHubPrUrl('https://github.com/owner/../pull/5')).toBeNull();
  });

  it('parses owners and repos with dots, dashes and underscores', () => {
    expect(parseGitHubPrUrl('https://github.com/my.repo/a-b_c/pull/1')).toEqual({
      owner: 'my.repo',
      repo: 'a-b_c',
      number: 1,
    });
  });
});
