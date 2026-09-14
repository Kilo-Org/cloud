import { describe, expect, it } from 'vitest';

import { parseProviderPrUrl } from './provider-pr-url';

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
