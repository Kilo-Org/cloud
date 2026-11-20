import { describe, expect, it } from 'vitest';

import {
  getCodeReviewJobsHref,
  getCodeReviewRepositoryUrl,
  matchesCodeReviewUrlSuffix,
} from './links';

// Moved from apps/web/src/lib/code-reviews/code-review-links.test.ts —
// assertions kept identical, only the test runner import changed
// (@jest/globals -> vitest, matching this package's test setup).
describe('getCodeReviewRepositoryUrl', () => {
  it.each([
    ['github', 'https://github.com/kilocode/app/pull/42', 'https://github.com/kilocode/app'],
    [
      'gitlab',
      'https://gitlab.com/kilocode/app/-/merge_requests/42',
      'https://gitlab.com/kilocode/app',
    ],
    [
      'bitbucket',
      'https://bitbucket.org/kilocode/app/pull-requests/42',
      'https://bitbucket.org/kilocode/app',
    ],
  ] as const)('returns the %s repository URL', (platform, reviewUrl, repositoryUrl) => {
    expect(getCodeReviewRepositoryUrl(platform, reviewUrl)).toBe(repositoryUrl);
  });

  it.each([
    ['github', 'https://github.com/kilocode/app/pull/42/files', 'https://github.com/kilocode/app'],
    [
      'gitlab',
      'https://gitlab.com/kilocode/app/-/merge_requests/42/diffs',
      'https://gitlab.com/kilocode/app',
    ],
    [
      'bitbucket',
      'https://bitbucket.org/kilocode/app/pull-requests/42/diff',
      'https://bitbucket.org/kilocode/app',
    ],
  ] as const)(
    'returns the %s repository URL for a link copied from a sub-page',
    (platform, reviewUrl, repositoryUrl) => {
      expect(getCodeReviewRepositoryUrl(platform, reviewUrl)).toBe(repositoryUrl);
    }
  );

  it('drops the query and fragment that address the review view', () => {
    expect(
      getCodeReviewRepositoryUrl(
        'github',
        'https://github.com/kilocode/app/pull/42?tab=files#discussion_r1'
      )
    ).toBe('https://github.com/kilocode/app');
  });

  it('keeps a nested GitLab group path', () => {
    expect(
      getCodeReviewRepositoryUrl('gitlab', 'https://gitlab.com/group/sub/app/-/merge_requests/7')
    ).toBe('https://gitlab.com/group/sub/app');
  });

  it('leaves a URL alone when the review segment appears only in the query or fragment', () => {
    const inQuery = 'https://github.com/kilocode/app/issues?q=/pull/42';
    expect(getCodeReviewRepositoryUrl('github', inQuery)).toBe(inQuery);

    const inFragment = 'https://github.com/kilocode/app/files#/pull/42';
    expect(getCodeReviewRepositoryUrl('github', inFragment)).toBe(inFragment);
  });

  it('preserves URLs that do not end in a provider review path', () => {
    const repositoryUrl = 'https://bitbucket.org/kilocode/app';
    expect(getCodeReviewRepositoryUrl('bitbucket', repositoryUrl)).toBe(repositoryUrl);
  });
});

describe('matchesCodeReviewUrlSuffix', () => {
  it('matches a github PR URL', () => {
    expect(matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/pull/123')).toBe(
      true
    );
  });

  it.each([
    ['github', 'https://github.com/owner/repo/pull/123/files'],
    ['gitlab', 'https://gitlab.com/group/project/-/merge_requests/123/diffs'],
    ['bitbucket', 'https://bitbucket.org/owner/repo/pull-requests/123/diff'],
  ] as const)('matches a %s link copied from a sub-page', (platform, url) => {
    expect(matchesCodeReviewUrlSuffix(platform, url)).toBe(true);
  });

  it('matches with trailing slash/query/hash', () => {
    expect(matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/pull/123/')).toBe(
      true
    );
    expect(
      matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/pull/123?tab=files')
    ).toBe(true);
    expect(
      matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/pull/123#discussion_r1')
    ).toBe(true);
  });

  it('rejects trailing garbage after the number', () => {
    expect(matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/pull/123abc')).toBe(
      false
    );
  });

  it('rejects a review segment that appears only in the query or fragment', () => {
    expect(
      matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/issues?q=see/pull/123')
    ).toBe(false);
    expect(
      matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/files#pull/123')
    ).toBe(false);
  });

  it('rejects a GitHub path without owner/repo and a GitLab path without a project', () => {
    expect(matchesCodeReviewUrlSuffix('github', 'https://github.com/pull/123')).toBe(false);
    expect(matchesCodeReviewUrlSuffix('gitlab', 'https://gitlab.com/-/merge_requests/1')).toBe(
      false
    );
  });

  it('does not anchor the host or protocol', () => {
    expect(matchesCodeReviewUrlSuffix('github', 'ftp://evil.example/owner/repo/pull/123')).toBe(
      true
    );
  });
});

describe('getCodeReviewJobsHref', () => {
  it('returns the organization Bitbucket Jobs view', () => {
    expect(getCodeReviewJobsHref('bitbucket', '4f24483f-5394-47f9-a047-4c039c24f457')).toBe(
      '/organizations/4f24483f-5394-47f9-a047-4c039c24f457/code-reviews?platform=bitbucket&view=jobs'
    );
  });

  it('preserves the provider on personal Code Reviewer links', () => {
    expect(getCodeReviewJobsHref('gitlab')).toBe('/code-reviews?platform=gitlab');
  });
});
