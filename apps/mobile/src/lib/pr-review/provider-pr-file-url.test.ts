import { describe, expect, it } from 'vitest';

import { githubPrRef, providerPrFileUrl, type ProviderPrLink } from './provider-pr-ref';

const gitlabRef = { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 } as const;
const bitbucketRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'api',
  prId: 42,
} as const;

function link(ref: ProviderPrLink['ref'], serverWebUrl: string | null = null): ProviderPrLink {
  return { ref, serverWebUrl };
}

/**
 * Only GitHub publishes a per-file diff anchor a client can build. GitLab and
 * Bitbucket expose none, so the whole diff page is the target there — a link
 * that at least lands the reader on the right change.
 */
describe('providerPrFileUrl', () => {
  it('anchors a GitHub file diff by its percent-encoded path', () => {
    expect(providerPrFileUrl(link(githubPrRef('octocat', 'hello', 7)), 'src/a b.ts')).toBe(
      'https://github.com/octocat/hello/pull/7/files#diff-src%2Fa%20b.ts'
    );
  });

  it('targets the GitLab merge request diff page', () => {
    expect(
      providerPrFileUrl(
        link(gitlabRef, 'https://gitlab.example.com/group/sub/repo/-/merge_requests/12'),
        'src/a.ts'
      )
    ).toBe('https://gitlab.example.com/group/sub/repo/-/merge_requests/12/diffs');
  });

  it('targets the Bitbucket pull request diff page', () => {
    expect(providerPrFileUrl(link(bitbucketRef), 'src/a.ts')).toBe(
      'https://bitbucket.org/acme/api/pull-requests/42/diff'
    );
  });

  it('has no file URL where the change has no web URL', () => {
    const noUrl = link({ platform: 'gitlab', projectPath: 'group/repo', mrIid: 1 });
    expect(providerPrFileUrl(noUrl, 'src/a.ts')).toBeNull();
  });
});
