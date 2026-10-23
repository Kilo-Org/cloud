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

import { hasPRCommentWithMarker } from './adapter';

const MARKER = '<!-- kilo-billing-notice -->';

function lastPageHeader(page: number) {
  return {
    link: `<https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=${page}>; rel="last"`,
  };
}

function fullPage() {
  return Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    body: 'ordinary discussion',
    updated_at: '2026-05-01T00:00:00Z',
  }));
}

beforeEach(() => {
  mockListComments.mockReset();
});

describe('hasPRCommentWithMarker', () => {
  it('returns true for a marker comment from the trusted app', async () => {
    mockListComments.mockResolvedValueOnce({
      headers: {},
      data: [
        {
          id: 1,
          body: MARKER,
          updated_at: '2026-05-02T00:00:00Z',
          performed_via_github_app: { id: 'test-app-id' },
        },
      ],
    });

    await expect(hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER)).resolves.toBe(true);
    expect(mockListComments).toHaveBeenCalledTimes(1);
  });

  it('ignores a marker copied into a comment from another author', async () => {
    mockListComments.mockResolvedValueOnce({
      headers: {},
      data: [
        {
          id: 1,
          body: MARKER,
          updated_at: '2026-05-02T00:00:00Z',
          performed_via_github_app: { id: 'someone-else' },
        },
      ],
    });

    await expect(hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER)).resolves.toBe(false);
  });

  it('reads only the most recent pages when the comment list is longer than the cap', async () => {
    mockListComments.mockResolvedValue({ headers: lastPageHeader(12), data: fullPage() });

    await expect(hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER)).resolves.toBe(false);

    const requestedPages = mockListComments.mock.calls.map(call => call[0].page);
    expect(requestedPages).toEqual([1, 8, 9, 10, 11, 12]);
  });

  it('finds the marker on a later page within the cap', async () => {
    mockListComments
      .mockResolvedValueOnce({ headers: lastPageHeader(2), data: fullPage() })
      .mockResolvedValueOnce({
        headers: {},
        data: [
          {
            id: 500,
            body: MARKER,
            updated_at: '2026-05-02T00:00:00Z',
            performed_via_github_app: { id: 'test-app-id' },
          },
        ],
      });

    await expect(hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER)).resolves.toBe(true);
    expect(mockListComments).toHaveBeenCalledTimes(2);
  });
});
