/**
 * The GitHub adapter is globally mocked through the `@/` alias in Jest config.
 * Import the relative module path here so this test exercises the real adapter.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_LITE_APP_ID = 'test-lite-app-id';
process.env.GITHUB_LITE_APP_PRIVATE_KEY = 'test-lite-private-key';

const mockListComments = jest.fn();

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    issues: { listComments: mockListComments },
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({ token: 'mock-token', expiresAt: '2099-01-01' })),
}));

import { findKiloReviewComment } from './adapter';

beforeEach(() => {
  mockListComments.mockReset();
});

describe('findKiloReviewComment', () => {
  it('finds a marked Kilo review comment across paginated issue comments', async () => {
    mockListComments
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          body: 'ordinary discussion',
          updated_at: '2026-05-01T00:00:00Z',
        })),
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 101,
            body: '<!-- kilo-review -->\n## Code Review Summary\nOlder summary',
            updated_at: '2026-05-02T00:00:00Z',
            performed_via_github_app: { id: 'test-app-id' },
          },
          {
            id: 102,
            body: '<!-- kilo-review -->\n## Code Review Summary\nLatest summary',
            updated_at: '2026-05-03T00:00:00Z',
            performed_via_github_app: { id: 'test-app-id' },
          },
        ],
      });

    await expect(findKiloReviewComment('42', 'acme', 'widgets', 7)).resolves.toEqual({
      commentId: 102,
      body: '<!-- kilo-review -->\n## Code Review Summary\nLatest summary',
    });

    expect(mockListComments).toHaveBeenNthCalledWith(1, {
      owner: 'acme',
      repo: 'widgets',
      issue_number: 7,
      per_page: 100,
      page: 1,
    });
    expect(mockListComments).toHaveBeenNthCalledWith(2, {
      owner: 'acme',
      repo: 'widgets',
      issue_number: 7,
      per_page: 100,
      page: 2,
    });
  });

  it('ignores a marker comment not authored by the trusted app', async () => {
    mockListComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          body: '<!-- kilo-review -->\n## Code Review Summary\nCopied by a user',
          updated_at: '2026-05-01T00:00:00Z',
          performed_via_github_app: { id: 'someone-else' },
        },
        {
          id: 2,
          body: '<!-- kilo-review -->\n## Code Review Summary\nReal summary',
          updated_at: '2026-05-02T00:00:00Z',
          performed_via_github_app: { id: 'test-app-id' },
        },
      ],
    });

    await expect(findKiloReviewComment('42', 'acme', 'widgets', 7)).resolves.toEqual({
      commentId: 2,
      body: '<!-- kilo-review -->\n## Code Review Summary\nReal summary',
    });
  });

  it('ignores every marker comment when none is authored by the trusted app', async () => {
    mockListComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          body: '<!-- kilo-review -->\n## Code Review Summary\nCopied',
          updated_at: '2026-05-01T00:00:00Z',
          performed_via_github_app: { id: 'someone-else' },
        },
      ],
    });

    await expect(findKiloReviewComment('42', 'acme', 'widgets', 7)).resolves.toBeNull();
  });

  it('stops instead of creating a duplicate after the safe scan limit', async () => {
    mockListComments.mockResolvedValue({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        body: 'ordinary discussion',
        updated_at: '2026-05-01T00:00:00Z',
      })),
    });

    await expect(findKiloReviewComment('42', 'acme', 'widgets', 7)).rejects.toThrow(
      'safe issue-comment scan limit'
    );

    expect(mockListComments).toHaveBeenCalledTimes(5);
  });
});
