const mockGetAuthenticated = jest.fn();
const mockPullsGet = jest.fn();
const mockPullsListCommits = jest.fn();
const mockPaginate = jest.fn();
const mockInstallationAuth = jest.fn();
const mockOctokitRequest = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: { users: { getAuthenticated: mockGetAuthenticated } },
    pulls: { get: mockPullsGet, listCommits: mockPullsListCommits },
    paginate: mockPaginate,
    request: mockOctokitRequest,
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => mockInstallationAuth),
}));

jest.mock('../../github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(),
}));

jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: () => ({
    clientId: 'github-client-id',
    clientSecret: 'github-client-secret',
    appId: '123',
    privateKey: 'private-key',
  }),
}));

import {
  exchangeGitHubOAuthCode,
  fetchPullRequestByNumber,
  GitHubRateLimitError,
  toGitHubRateLimitError,
} from './adapter';
import { verifySessionPullRequestLink } from './pr-link-identity';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

function tokenResponse() {
  return Response.json({ access_token: 'gho_access-token' });
}

function requestBody(fetchMock: jest.SpiedFunction<typeof fetch>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] ?? [];
  if (!init || typeof init.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body);
}

describe('exchangeGitHubOAuthCode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticated.mockResolvedValue({ data: { id: 101, login: 'octocat' } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Regression test for a real bug: @octokit/oauth-methods' exchangeWebFlowCode
  // never forwarded a supplied code_verifier to GitHub for clientType:
  // 'github-app', so a PKCE-bound authorization code (requested with a
  // code_challenge, as beginConnection does) was rejected by GitHub with
  // invalid_grant ("A code_verifier was not included, but the authorization
  // request included a code_challenge"). This asserts the actual outbound
  // request shape rather than a full OAuth round trip, which isn't
  // unit-testable.
  it('includes code_verifier in the token request when a PKCE verifier is provided', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(tokenResponse());

    await expect(
      exchangeGitHubOAuthCode('auth-code', 'standard', 'the-code-verifier')
    ).resolves.toEqual({ id: '101', login: 'octocat', accessToken: 'gho_access-token' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({ method: 'POST' })
    );
    expect(requestBody(fetchMock)).toEqual({
      client_id: 'github-client-id',
      client_secret: 'github-client-secret',
      code: 'auth-code',
      code_verifier: 'the-code-verifier',
    });
  });

  it('omits code_verifier from the token request when no verifier is provided', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(tokenResponse());

    await expect(exchangeGitHubOAuthCode('auth-code', 'standard')).resolves.toEqual({
      id: '101',
      login: 'octocat',
      accessToken: 'gho_access-token',
    });

    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty('code_verifier');
    expect(body).toEqual({
      client_id: 'github-client-id',
      client_secret: 'github-client-secret',
      code: 'auth-code',
    });
  });

  it('surfaces the GitHub OAuth error body instead of a generic failure', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        error: 'invalid_grant',
        error_description:
          'A code_verifier was not included, but the authorization request included a code_challenge.',
      })
    );

    await expect(exchangeGitHubOAuthCode('auth-code', 'standard', 'a-verifier')).rejects.toThrow(
      /invalid_grant.*code_verifier was not included/
    );
  });

  it('rejects when GitHub responds with a non-2xx status', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 502 }));

    await expect(exchangeGitHubOAuthCode('auth-code', 'standard')).rejects.toThrow(
      'GitHub OAuth code exchange failed (502)'
    );
  });

  it('rejects with a clear, attributed error when GitHub responds 2xx with a non-JSON body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('not json', { status: 200 }));

    await expect(exchangeGitHubOAuthCode('auth-code', 'standard')).rejects.toThrow(
      'GitHub OAuth code exchange returned a non-JSON response'
    );
  });
});

function githubPrPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    html_url: 'https://github.com/kilo/repo/pull/7',
    state: 'open',
    draft: false,
    merged_at: null,
    title: 'Feature Z',
    head: { sha: 'head-sha', ref: 'feature/z', repo: { full_name: 'kilo/repo' } },
    base: { ref: 'main', repo: { full_name: 'kilo/repo' } },
    updated_at: '2026-01-01T00:00:00Z',
    created_at: '2025-12-31T23:00:00Z',
    ...overrides,
  };
}

const fetchParams = {
  installationId: 12345,
  owner: 'kilo',
  repo: 'repo',
  number: 7,
  appType: 'standard' as const,
};

function httpError(status: number, message: string, headers?: Record<string, string>) {
  return Object.assign(new Error(message), {
    status,
    ...(headers ? { response: { headers } } : {}),
  });
}

describe('toGitHubRateLimitError', () => {
  const NOW = Date.parse('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an already typed error unchanged so its deadline is preserved', () => {
    const typed = new GitHubRateLimitError(new Date(NOW + 5_000));

    expect(toGitHubRateLimitError(typed)).toBe(typed);
  });

  it('classifies a 403 with Retry-After delta seconds', () => {
    const result = toGitHubRateLimitError(
      httpError(403, 'You have exceeded a secondary rate limit', { 'retry-after': '120' })
    );

    expect(result).toBeInstanceOf(GitHubRateLimitError);
    expect(result?.resetAt.getTime()).toBe(NOW + 120_000);
  });

  it('classifies a 403 with Retry-After even when the message is not a rate message', () => {
    const result = toGitHubRateLimitError(
      httpError(403, 'Forbidden', { 'retry-after': new Date(NOW + 90_000).toUTCString() })
    );

    expect(result?.resetAt.getTime()).toBe(NOW + 90_000);
  });

  it('classifies a 429 with an HTTP-date Retry-After', () => {
    const result = toGitHubRateLimitError(
      httpError(429, 'Too Many Requests', { 'retry-after': new Date(NOW + 45_000).toUTCString() })
    );

    expect(result?.resetAt.getTime()).toBe(NOW + 45_000);
  });

  it('uses x-ratelimit-reset for a primary limit and the later of both signals', () => {
    const reset = String(Math.floor((NOW + 300_000) / 1000));
    const result = toGitHubRateLimitError(
      httpError(429, 'rate limit exceeded', {
        'retry-after': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': reset,
      })
    );

    expect(result?.resetAt.getTime()).toBe(NOW + 300_000);
  });

  it('ignores x-ratelimit-reset while the quota is still available', () => {
    const reset = String(Math.floor((NOW + 3_600_000) / 1000));
    const result = toGitHubRateLimitError(
      httpError(403, 'secondary rate limit', {
        'retry-after': '60',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': reset,
      })
    );

    expect(result?.resetAt.getTime()).toBe(NOW + 60_000);
  });

  it('falls back to at least 60 seconds when no deadline is specified', () => {
    const result = toGitHubRateLimitError(httpError(429, 'rate limit exceeded'));

    expect(result?.resetAt.getTime()).toBe(NOW + 60_000);
  });

  it('treats an invalid HTTP-date Retry-After as unspecified', () => {
    const result = toGitHubRateLimitError(
      httpError(403, 'rate limit exceeded', { 'retry-after': 'not-a-date' })
    );

    expect(result?.resetAt.getTime()).toBe(NOW + 60_000);
  });

  it('does not treat a genuine 403 permission denial as a rate limit', () => {
    expect(
      toGitHubRateLimitError(httpError(403, 'Resource not accessible by integration'))
    ).toBeNull();
  });
});

describe('fetchPullRequestByNumber', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInstallationAuth.mockReset().mockResolvedValue({
      token: 'installation-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the base/head repo, head ref and head sha needed to verify identity', async () => {
    mockPullsGet.mockResolvedValue({ data: githubPrPayload() });

    await expect(fetchPullRequestByNumber(fetchParams)).resolves.toEqual({
      number: 7,
      htmlUrl: 'https://github.com/kilo/repo/pull/7',
      state: 'open',
      title: 'Feature Z',
      headSha: 'head-sha',
      updatedAt: '2026-01-01T00:00:00Z',
      createdAt: '2025-12-31T23:00:00Z',
      baseRepoFullName: 'kilo/repo',
      headRepoFullName: 'kilo/repo',
      headRef: 'feature/z',
      baseRef: 'main',
      stackNumber: null,
      stackPosition: null,
      stackSize: null,
    });
    expect(mockPullsGet).toHaveBeenCalledWith({ owner: 'kilo', repo: 'repo', pull_number: 7 });
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it.each([true, false, null])(
    'includes mergeability %s from the existing PR GET',
    async mergeable => {
      mockPullsGet.mockResolvedValue({
        data: githubPrPayload({
          base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'kilo/repo' } },
          mergeable,
          mergeable_state: mergeable === false ? 'dirty' : 'unknown',
        }),
      });
      expect(await fetchPullRequestByNumber(fetchParams)).toMatchObject({
        baseSha: 'b'.repeat(40),
        baseRef: 'main',
        mergeable,
        mergeableState: mergeable === false ? 'dirty' : 'unknown',
      });
      expect(mockPullsGet).toHaveBeenCalledTimes(1);
    }
  );

  it('maps the GitHub stack metadata and base ref onto flat fields', async () => {
    mockPullsGet.mockResolvedValue({
      data: githubPrPayload({
        base: { ref: 'feature/stack-base', repo: { full_name: 'kilo/repo' } },
        stack: { number: 2, position: 1, size: 3 },
      }),
    });

    const result = await fetchPullRequestByNumber(fetchParams);

    expect(result).toMatchObject({
      baseRef: 'feature/stack-base',
      stackNumber: 2,
      stackPosition: 1,
      stackSize: 3,
    });
  });

  it('reports an empty head repo when the head repository is gone (deleted fork)', async () => {
    mockPullsGet.mockResolvedValue({
      data: githubPrPayload({
        head: { sha: 'head-sha', ref: 'feature/z', repo: null },
      }),
    });

    const result = await fetchPullRequestByNumber(fetchParams);
    expect(result?.headRepoFullName).toBe('');
  });

  it('walks commits only when includeCommits is requested and the SHA is not the head', async () => {
    mockPullsGet.mockResolvedValue({ data: githubPrPayload() });
    mockPullsListCommits.mockResolvedValue({ data: [{ sha: 'older-sha' }, { sha: 'head-sha' }] });

    const result = await fetchPullRequestByNumber({ ...fetchParams, includeCommits: true });

    expect(mockPullsListCommits).toHaveBeenCalledTimes(1);
    expect(mockPullsListCommits).toHaveBeenCalledWith({
      owner: 'kilo',
      repo: 'repo',
      pull_number: 7,
      per_page: 100,
      page: 1,
    });
    expect(result?.commitShas).toEqual(['older-sha', 'head-sha']);
  });

  it('skips the commit walk when the session SHA already is the PR head', async () => {
    mockPullsGet.mockResolvedValue({ data: githubPrPayload() });

    const result = await fetchPullRequestByNumber({
      ...fetchParams,
      includeCommits: true,
      expectedHeadSha: 'head-sha',
    });

    expect(mockPullsListCommits).not.toHaveBeenCalled();
    expect(mockPaginate).not.toHaveBeenCalled();
    expect(result?.commitShas).toBeUndefined();
    expect(result?.headSha).toBe('head-sha');
  });

  it('caps the commit walk so a very large PR cannot page without bound', async () => {
    mockPullsGet.mockResolvedValue({ data: githubPrPayload() });
    const fullPage = Array.from({ length: 100 }, (_value, index) => ({ sha: `sha-${index}` }));
    mockPullsListCommits.mockResolvedValue({ data: fullPage });

    const result = await fetchPullRequestByNumber({
      ...fetchParams,
      includeCommits: true,
      expectedHeadSha: 'a-non-head-sha',
    });

    expect(mockPullsListCommits).toHaveBeenCalledTimes(10);
    // Every page is full, so the walk stops at the cap and the expected SHA is
    // never found — the caller rejects the link rather than paging forever.
    expect(result?.commitShas).toHaveLength(1000);
    expect(result?.commitShas).not.toContain('a-non-head-sha');
  });

  it('returns null when the PR is not found', async () => {
    mockPullsGet.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

    await expect(fetchPullRequestByNumber(fetchParams)).resolves.toBeNull();
  });

  it('throws GitHubRateLimitError on a rate-limited response', async () => {
    mockPullsGet.mockRejectedValue(
      Object.assign(new Error('rate limit exceeded'), { status: 403 })
    );

    await expect(fetchPullRequestByNumber(fetchParams)).rejects.toMatchObject({
      name: 'GitHubRateLimitError',
    });
  });

  it('classifies a rate-limited install token mint instead of failing generically', async () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockInstallationAuth.mockRejectedValue(
      httpError(403, 'rate limit exceeded', { 'retry-after': '120' })
    );

    const result = fetchPullRequestByNumber(fetchParams);
    await expect(result).rejects.toMatchObject({
      name: 'GitHubRateLimitError',
      resetAt: new Date(now + 120_000),
    });
    expect(mockPullsGet).not.toHaveBeenCalled();
  });

  it('does not treat an installation-token 404 as proof that the PR is missing', async () => {
    const error = httpError(404, 'Installation no longer exists');
    mockInstallationAuth.mockRejectedValue(error);
    await expect(fetchPullRequestByNumber(fetchParams)).rejects.toBe(error);
    expect(mockPullsGet).not.toHaveBeenCalled();
  });

  it('makes no token or PR requests after the shared deadline has already expired', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchPullRequestByNumber({ ...fetchParams, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockInstallationAuth).not.toHaveBeenCalled();
    expect(mockPullsGet).not.toHaveBeenCalled();
  });

  it('preserves the Retry-After deadline from a rate-limited PR read', async () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockPullsGet.mockRejectedValue(httpError(403, 'secondary rate limit', { 'retry-after': '90' }));

    await expect(fetchPullRequestByNumber(fetchParams)).rejects.toMatchObject({
      name: 'GitHubRateLimitError',
      resetAt: new Date(now + 90_000),
    });
  });

  it('passes the shared abort signal through every core request', async () => {
    mockPullsGet.mockResolvedValue({ data: githubPrPayload() });
    mockPullsListCommits.mockResolvedValue({ data: [{ sha: 'head-sha' }] });
    const controller = new AbortController();

    await fetchPullRequestByNumber({
      ...fetchParams,
      includeCommits: true,
      expectedHeadSha: 'different-sha',
      signal: controller.signal,
    });

    expect(Octokit).toHaveBeenCalledWith({ request: { signal: controller.signal } });
    expect(createAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({ request: mockOctokitRequest })
    );

    expect(mockPullsGet).toHaveBeenCalledWith({
      owner: 'kilo',
      repo: 'repo',
      pull_number: 7,
      request: { signal: controller.signal },
    });
    expect(mockPullsListCommits).toHaveBeenCalledWith({
      owner: 'kilo',
      repo: 'repo',
      pull_number: 7,
      per_page: 100,
      page: 1,
      request: { signal: controller.signal },
    });
  });

  it('accepts the session own PR through the identity helper', async () => {
    mockPullsGet.mockResolvedValue({ data: githubPrPayload() });
    const fetched = await fetchPullRequestByNumber(fetchParams);
    expect(fetched).not.toBeNull();

    expect(
      verifySessionPullRequestLink({
        sessionRepo: { gitUrl: 'https://github.com/kilo/repo.git', gitBranch: 'feature/z' },
        link: {
          prUrl: 'https://github.com/kilo/repo/pull/7',
          prNumber: 7,
          headRef: 'feature/z',
          headSha: 'head-sha',
        },
        pullRequest: fetched!,
      })
    ).toEqual({ verified: true, evidence: 'head_sha' });
  });

  it('rejects a fork PR with the same branch name through the identity helper', async () => {
    mockPullsGet.mockResolvedValue({
      data: githubPrPayload({
        head: { sha: 'head-sha', ref: 'feature/z', repo: { full_name: 'fork-owner/repo' } },
      }),
    });
    const fetched = await fetchPullRequestByNumber(fetchParams);
    expect(fetched).not.toBeNull();

    expect(
      verifySessionPullRequestLink({
        sessionRepo: { gitUrl: 'https://github.com/kilo/repo.git', gitBranch: 'feature/z' },
        link: {
          prUrl: 'https://github.com/kilo/repo/pull/7',
          prNumber: 7,
          headRef: 'feature/z',
          headSha: 'head-sha',
        },
        pullRequest: fetched!,
      })
    ).toEqual({ verified: false, reason: 'head_repo_mismatch' });
  });
});
