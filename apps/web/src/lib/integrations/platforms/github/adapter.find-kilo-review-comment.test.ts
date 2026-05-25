/**
 * The GitHub adapter is globally mocked through the `@/` alias in Jest config.
 * Import the relative module path here so this test exercises the real adapter.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_LITE_APP_ID = 'test-lite-app-id';
process.env.GITHUB_LITE_APP_PRIVATE_KEY = 'test-lite-private-key';

const mockPaginate = jest.fn();
const mockListComments = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    issues: { listComments: mockListComments },
    paginate: mockPaginate,
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({ token: 'mock-token', expiresAt: '2099-01-01' })),
}));

import { findKiloReviewComment } from './adapter';

beforeEach(() => {
  mockPaginate.mockReset();
  mockListComments.mockReset();
});

describe('findKiloReviewComment', () => {
  it('finds a marked Kilo review comment across paginated issue comments', async () => {
    mockPaginate.mockResolvedValueOnce([
      {
        id: 1,
        body: 'ordinary discussion',
        updated_at: '2026-05-01T00:00:00Z',
      },
      {
        id: 2,
        body: '<!-- kilo-review -->\n## Code Review Summary\nOlder summary',
        updated_at: '2026-05-02T00:00:00Z',
      },
      {
        id: 3,
        body: '<!-- kilo-review -->\n## Code Review Summary\nLatest summary',
        updated_at: '2026-05-03T00:00:00Z',
      },
    ]);

    await expect(findKiloReviewComment('42', 'acme', 'widgets', 7)).resolves.toEqual({
      commentId: 3,
      body: '<!-- kilo-review -->\n## Code Review Summary\nLatest summary',
    });

    expect(mockPaginate).toHaveBeenCalledWith(mockListComments, {
      owner: 'acme',
      repo: 'widgets',
      issue_number: 7,
      per_page: 100,
    });
  });
});
