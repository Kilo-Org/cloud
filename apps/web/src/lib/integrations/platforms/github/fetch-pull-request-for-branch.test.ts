/**
 * Tests for `fetchPullRequestForBranch` in `adapter.ts`.
 *
 * The adapter module is globally mocked via the jest `moduleNameMapper` entry
 * for `@/lib/integrations/platforms/github/adapter`. We bypass that by importing
 * via a relative path, then mock `@octokit/rest` and the installation-token
 * generation so we never hit real GitHub.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_LITE_APP_ID = 'test-lite-app-id';
process.env.GITHUB_LITE_APP_PRIVATE_KEY = 'test-lite-private-key';

const mockPullsList = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: { list: mockPullsList },
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({ token: 'mock-token', expiresAt: '2099-01-01' })),
}));

import { fetchPullRequestForBranch, GitHubRateLimitError } from './adapter';

type ListResponse = {
  data: Array<{
    number: number;
    html_url: string;
    state: 'open' | 'closed';
    title: string;
    updated_at: string;
    merged_at: string | null;
    draft?: boolean;
    head: { sha: string };
  }>;
};

function okResponse(data: ListResponse['data']): ListResponse {
  return { data };
}

function httpError(status: number, headers: Record<string, string> = {}, message?: string) {
  return Object.assign(new Error(message ?? `HTTP ${status}`), {
    status,
    response: { headers },
  });
}

beforeEach(() => {
  mockPullsList.mockReset();
});

describe('fetchPullRequestForBranch', () => {
  const params = {
    installationId: 42,
    owner: 'acme',
    repo: 'widgets',
    branch: 'feature/login',
    appType: 'standard' as const,
  };

  it('returns the single open PR when the API returns one result', async () => {
    mockPullsList.mockResolvedValueOnce(
      okResponse([
        {
          number: 7,
          html_url: 'https://github.com/acme/widgets/pull/7',
          state: 'open',
          title: 'Add login page',
          updated_at: '2026-04-20T10:00:00Z',
          merged_at: null,
          head: { sha: 'abc123' },
        },
      ])
    );

    const result = await fetchPullRequestForBranch(params);

    expect(result).toEqual({
      number: 7,
      htmlUrl: 'https://github.com/acme/widgets/pull/7',
      state: 'open',
      title: 'Add login page',
      headSha: 'abc123',
      updatedAt: '2026-04-20T10:00:00Z',
    });

    expect(mockPullsList).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      head: 'acme:feature/login',
      state: 'all',
      per_page: 10,
      sort: 'updated',
      direction: 'desc',
    });
  });

  it('returns draft state for an open draft PR', async () => {
    mockPullsList.mockResolvedValueOnce(
      okResponse([
        {
          number: 8,
          html_url: 'https://github.com/acme/widgets/pull/8',
          state: 'open',
          title: 'Work in progress',
          updated_at: '2026-04-20T10:00:00Z',
          merged_at: null,
          draft: true,
          head: { sha: 'draftsha' },
        },
      ])
    );

    const result = await fetchPullRequestForBranch(params);

    expect(result?.state).toBe('draft');
  });

  it('prefers an open PR over a more-recently-updated closed one', async () => {
    mockPullsList.mockResolvedValueOnce(
      okResponse([
        {
          number: 9,
          html_url: 'https://github.com/acme/widgets/pull/9',
          state: 'closed',
          title: 'Old attempt',
          updated_at: '2026-04-22T10:00:00Z',
          merged_at: null,
          head: { sha: 'closedsha' },
        },
        {
          number: 7,
          html_url: 'https://github.com/acme/widgets/pull/7',
          state: 'open',
          title: 'Current attempt',
          updated_at: '2026-04-20T10:00:00Z',
          merged_at: null,
          head: { sha: 'opensha' },
        },
      ])
    );

    const result = await fetchPullRequestForBranch(params);

    expect(result).toMatchObject({ number: 7, state: 'open', headSha: 'opensha' });
  });

  it('returns merged state when merged_at is set', async () => {
    mockPullsList.mockResolvedValueOnce(
      okResponse([
        {
          number: 11,
          html_url: 'https://github.com/acme/widgets/pull/11',
          state: 'closed',
          title: 'Merged work',
          updated_at: '2026-04-22T10:00:00Z',
          merged_at: '2026-04-22T09:59:00Z',
          head: { sha: 'mergedsha' },
        },
      ])
    );

    const result = await fetchPullRequestForBranch(params);

    expect(result?.state).toBe('merged');
  });

  it('falls back to the first result when no open PR exists', async () => {
    mockPullsList.mockResolvedValueOnce(
      okResponse([
        {
          number: 2,
          html_url: 'https://github.com/acme/widgets/pull/2',
          state: 'closed',
          title: 'Later closed',
          updated_at: '2026-04-22T10:00:00Z',
          merged_at: null,
          head: { sha: 'sha-2' },
        },
        {
          number: 1,
          html_url: 'https://github.com/acme/widgets/pull/1',
          state: 'closed',
          title: 'Earlier closed',
          updated_at: '2026-04-20T10:00:00Z',
          merged_at: null,
          head: { sha: 'sha-1' },
        },
      ])
    );

    const result = await fetchPullRequestForBranch(params);

    expect(result?.number).toBe(2);
    expect(result?.state).toBe('closed');
  });

  it('returns null when no PRs match', async () => {
    mockPullsList.mockResolvedValueOnce(okResponse([]));

    const result = await fetchPullRequestForBranch(params);

    expect(result).toBeNull();
  });

  it('returns null on 404 (repo no longer accessible)', async () => {
    mockPullsList.mockRejectedValueOnce(httpError(404));

    const result = await fetchPullRequestForBranch(params);

    expect(result).toBeNull();
  });

  it('throws GitHubRateLimitError on 403 with rate-limit reset header', async () => {
    const resetEpochSeconds = 1_800_000_000;
    mockPullsList.mockRejectedValueOnce(
      httpError(403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetEpochSeconds),
      })
    );

    await expect(fetchPullRequestForBranch(params)).rejects.toMatchObject({
      name: 'GitHubRateLimitError',
      resetAt: new Date(resetEpochSeconds * 1000),
    });
  });

  it('throws GitHubRateLimitError on 429', async () => {
    const resetEpochSeconds = 1_800_000_100;
    mockPullsList.mockRejectedValueOnce(
      httpError(429, { 'x-ratelimit-reset': String(resetEpochSeconds) })
    );

    const error = await fetchPullRequestForBranch(params).catch(e => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    if (error instanceof GitHubRateLimitError) {
      expect(error.resetAt).toEqual(new Date(resetEpochSeconds * 1000));
    }
  });

  it('throws GitHubRateLimitError when x-ratelimit-remaining is 0 even without 403/429', async () => {
    const resetEpochSeconds = 1_800_000_200;
    // Status 200 is nonsensical with this error shape, but the helper should
    // still recognise the rate-limit signal from the header.
    mockPullsList.mockRejectedValueOnce(
      httpError(500, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetEpochSeconds),
      })
    );

    await expect(fetchPullRequestForBranch(params)).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('throws GitHubRateLimitError on 403 with "secondary rate limit" message', async () => {
    mockPullsList.mockRejectedValueOnce(
      httpError(403, {}, 'You have exceeded a secondary rate limit.')
    );

    await expect(fetchPullRequestForBranch(params)).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('re-throws non-rate-limit 403 (permission denied) unchanged', async () => {
    // GitHub returns 403 when an installation lacks the required permission
    // (e.g. pull request read access). We must NOT wrap this as a rate limit,
    // or callers will incorrectly tell users to retry.
    const permissionError = httpError(403, {}, 'Resource not accessible by integration');
    mockPullsList.mockRejectedValueOnce(permissionError);

    await expect(fetchPullRequestForBranch(params)).rejects.toBe(permissionError);
  });

  it('re-throws unexpected errors unchanged', async () => {
    const boom = new Error('network exploded');
    mockPullsList.mockRejectedValueOnce(boom);

    await expect(fetchPullRequestForBranch(params)).rejects.toBe(boom);
  });
});
