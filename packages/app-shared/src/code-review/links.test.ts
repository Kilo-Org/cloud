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

  it('matches with trailing slash/query/hash', () => {
    expect(matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/pull/123/')).toBe(
      true
    );
    expect(
      matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/pull/123?tab=files')
    ).toBe(true);
  });

  it('rejects trailing garbage after the number', () => {
    expect(matchesCodeReviewUrlSuffix('github', 'https://github.com/owner/repo/pull/123abc')).toBe(
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
