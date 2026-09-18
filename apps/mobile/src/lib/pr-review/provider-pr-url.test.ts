import { describe, expect, it } from 'vitest';

import { findFirstProviderPrUrl, parseProviderPrUrl } from './provider-pr-url';

describe('parseProviderPrUrl — GitHub', () => {
  it('parses a github.com pull request into the GitHub ref', () => {
    expect(parseProviderPrUrl('https://github.com/octocat/hello-world/pull/42')).toEqual({
      platform: 'github',
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('tolerates trailing subpaths and query strings', () => {
    expect(parseProviderPrUrl('https://github.com/o/r/pull/7/files?diff=split')).toEqual({
      platform: 'github',
      owner: 'o',
      repo: 'r',
      number: 7,
    });
  });

  it('rejects a GitHub Enterprise host — the GitHub App serves github.com only', () => {
    expect(parseProviderPrUrl('https://github.example.com/octocat/hello-world/pull/42')).toBeNull();
  });
});

describe('parseProviderPrUrl — GitLab', () => {
  it('parses the gitlab.com modern form with the origin as instanceHint', () => {
    expect(parseProviderPrUrl('https://gitlab.com/group/sub/repo/-/merge_requests/123')).toEqual({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 123,
      instanceHint: 'https://gitlab.com',
    });
  });

  it('parses a self-managed host with a port, keeping the origin', () => {
    expect(
      parseProviderPrUrl('https://gitlab.example.com:8443/acme/api/-/merge_requests/9')
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'acme/api',
      mrIid: 9,
      instanceHint: 'https://gitlab.example.com:8443',
    });
  });

  it('parses the legacy form without the /-/ separator', () => {
    expect(parseProviderPrUrl('https://gitlab.example.com/group/project/merge_requests/5')).toEqual(
      {
        platform: 'gitlab',
        projectPath: 'group/project',
        mrIid: 5,
        instanceHint: 'https://gitlab.example.com',
      }
    );
  });

  it('prefers the real marker when the project path itself contains merge_requests', () => {
    // The first `merge_requests` segment is part of the project path; the
    // trailing `-/merge_requests/7` is the marker. Returning the first match
    // would open and comment on merge request 5 in `team/sub`.
    expect(
      parseProviderPrUrl('https://gitlab.com/team/sub/merge_requests/5/-/merge_requests/7')
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'team/sub/merge_requests/5',
      mrIid: 7,
      instanceHint: 'https://gitlab.com',
    });
  });

  it('tolerates trailing subpaths, queries and fragments', () => {
    expect(
      parseProviderPrUrl('https://gitlab.com/g/r/-/merge_requests/5/diffs?w=1#note_2')
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'g/r',
      mrIid: 5,
      instanceHint: 'https://gitlab.com',
    });
  });

  it('lowercases the host and keeps the scheme', () => {
    const ref = parseProviderPrUrl('https://GITLAB.Example.COM/G/Repo/-/merge_requests/1');
    expect(ref).toEqual({
      platform: 'gitlab',
      projectPath: 'G/Repo',
      mrIid: 1,
      instanceHint: 'https://gitlab.example.com',
    });
  });

  it('accepts http on a self-managed instance', () => {
    const ref = parseProviderPrUrl('http://git.lan/team/repo/-/merge_requests/2');
    expect(ref).not.toBeNull();
    expect(ref?.platform === 'gitlab' && ref.instanceHint).toBe('http://git.lan');
  });

  it('rejects a single-segment project path — the server requires a group', () => {
    expect(parseProviderPrUrl('https://gitlab.com/repo/merge_requests/1')).toBeNull();
    expect(parseProviderPrUrl('https://gitlab.com/repo/-/merge_requests/1')).toBeNull();
  });

  it('rejects dot segments, empty segments, and non-numeric iids', () => {
    expect(parseProviderPrUrl('https://gitlab.com/../repo/-/merge_requests/1')).toBeNull();
    expect(parseProviderPrUrl('https://gitlab.com/g//r/-/merge_requests/1')).toBeNull();
    expect(parseProviderPrUrl('https://gitlab.com/g/r/-/merge_requests/abc')).toBeNull();
    expect(parseProviderPrUrl('https://gitlab.com/g/r/-/merge_requests/0')).toBeNull();
  });

  it('rejects a lone "-" inside the project path — only the separator may be one', () => {
    expect(parseProviderPrUrl('https://gitlab.com/-/r/-/merge_requests/1')).toBeNull();
    expect(parseProviderPrUrl('https://gitlab.com/g/-/r/-/merge_requests/1')).toBeNull();
    expect(parseProviderPrUrl('https://gitlab.com/g/-/r/merge_requests/1')).toBeNull();
  });

  it('never reads a github.com URL as a GitLab MR', () => {
    expect(parseProviderPrUrl('https://github.com/g/r/-/merge_requests/1')).toBeNull();
  });

  it('rejects a GitLab path without a merge_requests marker', () => {
    expect(parseProviderPrUrl('https://gitlab.com/g/r/-/issues/5')).toBeNull();
    expect(parseProviderPrUrl('https://gitlab.com/g/r')).toBeNull();
  });
});

describe('parseProviderPrUrl — Bitbucket', () => {
  it('parses the plain pull request URL', () => {
    expect(parseProviderPrUrl('https://bitbucket.org/acme/api/pull-requests/42')).toEqual({
      platform: 'bitbucket',
      workspace: 'acme',
      repoSlug: 'api',
      prId: 42,
    });
  });

  it('parses the overview and other trailing-subpath variants', () => {
    expect(
      parseProviderPrUrl('https://bitbucket.org/acme/api/pull-requests/42/overview?tab=commits')
    ).toEqual({
      platform: 'bitbucket',
      workspace: 'acme',
      repoSlug: 'api',
      prId: 42,
    });
    expect(parseProviderPrUrl('https://bitbucket.org/acme/api/pull-requests/42/diff')).toEqual({
      platform: 'bitbucket',
      workspace: 'acme',
      repoSlug: 'api',
      prId: 42,
    });
  });

  it('rejects other hosts and malformed paths', () => {
    expect(
      parseProviderPrUrl('https://bitbucket.example.com/acme/api/pull-requests/42')
    ).toBeNull();
    expect(parseProviderPrUrl('https://bitbucket.org/acme/pull-requests/42')).toBeNull();
    expect(parseProviderPrUrl('https://bitbucket.org/acme/api/pull-requests/x')).toBeNull();
  });
});

describe('parseProviderPrUrl — garbage input', () => {
  it('returns null for empty, whitespace, non-http and non-review URLs', () => {
    expect(parseProviderPrUrl('')).toBeNull();
    expect(parseProviderPrUrl('   \n ')).toBeNull();
    expect(parseProviderPrUrl('not a url at all')).toBeNull();
    expect(parseProviderPrUrl('ftp://gitlab.com/g/r/-/merge_requests/1')).toBeNull();
    expect(parseProviderPrUrl('https://gitlab.com/o/r/pull/1')).toBeNull();
    expect(parseProviderPrUrl('https://app.kilo.ai/profile')).toBeNull();
  });

  it('never throws on credential-bearing or malformed authorities', () => {
    expect(parseProviderPrUrl('https://user:pass@gitlab.com/g/r/-/merge_requests/1')).toBeNull();
    expect(parseProviderPrUrl('https://')).toBeNull();
  });
});

describe('findFirstProviderPrUrl', () => {
  it('finds a GitHub pull request in free text', () => {
    expect(
      findFirstProviderPrUrl('See https://github.com/octocat/hello-world/pull/42 please')
    ).toEqual({ platform: 'github', owner: 'octocat', repo: 'hello-world', number: 42 });
  });

  it('finds a gitlab.com merge request in free text', () => {
    expect(
      findFirstProviderPrUrl('Fix the thing\nhttps://gitlab.com/group/repo/-/merge_requests/7')
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'group/repo',
      mrIid: 7,
      instanceHint: 'https://gitlab.com',
    });
  });

  it('finds a self-managed GitLab merge request in free text', () => {
    expect(
      findFirstProviderPrUrl('https://gitlab.example.com:8443/team/repo/-/merge_requests/9')
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'team/repo',
      mrIid: 9,
      instanceHint: 'https://gitlab.example.com:8443',
    });
  });

  it('finds a Bitbucket pull request in free text', () => {
    expect(
      findFirstProviderPrUrl('https://bitbucket.org/acme/api/pull-requests/42/overview')
    ).toEqual({ platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 });
  });

  it('returns the first review URL when several are present', () => {
    expect(
      findFirstProviderPrUrl(
        'https://github.com/octocat/hello-world/pull/42 https://gitlab.com/group/repo/-/merge_requests/7'
      )
    ).toEqual({ platform: 'github', owner: 'octocat', repo: 'hello-world', number: 42 });
  });

  it('returns null when nothing matches a provider', () => {
    expect(findFirstProviderPrUrl('no url here at all')).toBeNull();
    expect(findFirstProviderPrUrl('https://example.com/group/repo')).toBeNull();
    expect(findFirstProviderPrUrl('https://github.com/octocat/hello-world/issues/42')).toBeNull();
    expect(findFirstProviderPrUrl('')).toBeNull();
  });
});
