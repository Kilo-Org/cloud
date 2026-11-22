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
import {
  GITHUB_LISTING_TIMEOUT_MS,
  GitHubListingBudgetExceededError,
  MAX_GITHUB_LISTING_BYTES,
} from './listing-budget';

function lastPageHeader(page: number) {
  return {
    link: `<https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=${page}>; rel="last"`,
  };
}

beforeEach(() => {
  mockListComments.mockReset();
});

describe('findKiloReviewComment', () => {
  it('finds a marked Kilo review comment across paginated issue comments', async () => {
    mockListComments
      .mockResolvedValueOnce({
        headers: {
          link: '<https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=2>; rel="last"',
        },
        data: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          body: 'ordinary discussion',
          updated_at: '2026-05-01T00:00:00Z',
        })),
      })
      .mockResolvedValueOnce({
        headers: {},
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
      request: { signal: expect.any(AbortSignal) },
    });
    expect(mockListComments).toHaveBeenNthCalledWith(2, {
      owner: 'acme',
      repo: 'widgets',
      issue_number: 7,
      per_page: 100,
      page: 2,
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it('ignores a marker comment not authored by the trusted app', async () => {
    mockListComments.mockResolvedValueOnce({
      headers: {},
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
      headers: {},
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

  it('stops at the safe scan limit when the summary is not in the read pages', async () => {
    mockListComments.mockResolvedValue({
      headers: {
        link: '<https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=12>; rel="last"',
      },
      data: Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        body: 'ordinary discussion',
        updated_at: '2026-05-01T00:00:00Z',
      })),
    });

    await expect(findKiloReviewComment('42', 'acme', 'widgets', 7)).rejects.toThrow(
      'safe issue-comment scan limit'
    );

    const requestedPages = mockListComments.mock.calls.map(call => call[0].page);
    expect(requestedPages).toEqual([1, 2, 3, 11, 12]);
  });

  it('finds the summary on the first page of a long comment list', async () => {
    mockListComments
      .mockResolvedValueOnce({
        headers: {
          link: '<https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=12>; rel="last"',
        },
        data: [
          {
            id: 5,
            body: '<!-- kilo-review -->\n## Code Review Summary\nMaintained in place',
            updated_at: '2026-05-09T00:00:00Z',
            performed_via_github_app: { id: 'test-app-id' },
          },
          ...Array.from({ length: 99 }, (_, index) => ({
            id: 100 + index,
            body: 'ordinary discussion',
            updated_at: '2026-05-01T00:00:00Z',
          })),
        ],
      })
      .mockResolvedValue({
        headers: {
          link: '<https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=12>; rel="last"',
        },
        data: Array.from({ length: 100 }, (_, index) => ({
          id: 1000 + index,
          body: 'ordinary discussion',
          updated_at: '2026-05-01T00:00:00Z',
        })),
      });

    await expect(findKiloReviewComment('42', 'acme', 'widgets', 7)).resolves.toEqual({
      commentId: 5,
      body: '<!-- kilo-review -->\n## Code Review Summary\nMaintained in place',
    });

    expect(mockListComments).toHaveBeenCalledTimes(5);
  });

  it('covers every page of one scan with the same deadline', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      mockListComments.mockImplementation((params: { request: { signal: AbortSignal } }) => {
        const { signal } = params.request;
        signals.push(signal);
        if (signals.length === 1) {
          return Promise.resolve({
            headers: lastPageHeader(3),
            data: [{ id: 1, body: 'ordinary discussion', updated_at: '2026-05-01T00:00:00Z' }],
          });
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

      const scan = findKiloReviewComment('42', 'acme', 'widgets', 7);
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
      // The abort reason is named AbortError so Octokit's fetch wrapper rethrows it, and it
      // carries the typed error the scan reports.
      const [{ reason }] = signals;
      expect(reason.name).toBe('AbortError');
      expect(reason.cause).toBeInstanceOf(GitHubListingBudgetExceededError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a scan whose retained pages pass the byte budget', async () => {
    const padding = 'x'.repeat(60_000);
    mockListComments.mockResolvedValue({
      headers: lastPageHeader(12),
      data: Array.from({ length: 100 }, (_value, index) => ({
        id: index + 1,
        body: padding,
        updated_at: '2026-05-01T00:00:00Z',
      })),
    });

    const thrown: unknown = await findKiloReviewComment('42', 'acme', 'widgets', 7).catch(
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      `GitHub pagination limit exceeded: PR issue-comment scan returned more than ${MAX_GITHUB_LISTING_BYTES / (1024 * 1024)} MiB`
    );
    expect(mockListComments).toHaveBeenCalledTimes(3);
  });

  it('clears its deadline timer when the scan finishes', async () => {
    jest.useFakeTimers();
    try {
      mockListComments.mockResolvedValueOnce({
        headers: {},
        data: [{ id: 1, body: 'ordinary discussion', updated_at: '2026-05-01T00:00:00Z' }],
      });

      await expect(findKiloReviewComment('42', 'acme', 'widgets', 7)).resolves.toBeNull();

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
