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

import {
  GITHUB_LISTING_TIMEOUT_MS,
  GitHubListingBudgetExceededError,
  hasPRCommentWithMarker,
} from './adapter';

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

  it('reads both ends of a long comment list within the page cap', async () => {
    mockListComments.mockResolvedValue({ headers: lastPageHeader(12), data: fullPage() });

    await expect(hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER)).resolves.toBe(false);

    const requestedPages = mockListComments.mock.calls.map(call => call[0].page);
    expect(requestedPages).toEqual([1, 2, 3, 11, 12]);
  });

  it('finds a marker posted early on a long comment list', async () => {
    mockListComments
      .mockResolvedValueOnce({
        headers: lastPageHeader(12),
        data: [
          {
            id: 3,
            body: MARKER,
            updated_at: '2026-05-02T00:00:00Z',
            performed_via_github_app: { id: 'test-app-id' },
          },
          ...Array.from({ length: 99 }, (_, index) => ({
            id: 100 + index,
            body: 'ordinary discussion',
            updated_at: '2026-05-01T00:00:00Z',
          })),
        ],
      })
      .mockResolvedValue({ headers: lastPageHeader(12), data: fullPage() });

    await expect(hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER)).resolves.toBe(true);
    expect(mockListComments).toHaveBeenCalledTimes(5);
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

  it('covers every page of one scan with the same deadline', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      mockListComments.mockImplementation((params: { request: { signal: AbortSignal } }) => {
        const { signal } = params.request;
        signals.push(signal);
        if (signals.length === 1) {
          return Promise.resolve({ headers: lastPageHeader(12), data: fullPage() });
        }
        const { promise, reject } = Promise.withResolvers<never>();
        const abort = () => reject(signal.reason);
        if (signal.aborted) {
          abort();
          return promise;
        }
        signal.addEventListener('abort', abort, { once: true });
        return promise;
      });

      const scan = hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER);
      const settled = scan.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: PR issue-comment scan did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBe(signals[1]);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      const [{ reason }] = signals;
      expect(reason.name).toBe('AbortError');
      expect(reason.cause).toBeInstanceOf(GitHubListingBudgetExceededError);
    } finally {
      jest.useRealTimers();
    }
  });
});
