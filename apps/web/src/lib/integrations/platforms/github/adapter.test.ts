const mockGetAuthenticated = jest.fn();
const mockPullsGet = jest.fn();
const mockPullsListCommits = jest.fn();
const mockReposGetCollaboratorPermissionLevel = jest.fn();
const mockReposGet = jest.fn();
const mockReposListBranches = jest.fn();
const mockListReposAccessibleToInstallation = jest.fn();
const mockListInstallationRequests = jest.fn();
const mockPaginate = jest.fn();
const mockInstallationAuth = jest.fn();
const mockOctokitRequest = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: { users: { getAuthenticated: mockGetAuthenticated } },
    apps: {
      listReposAccessibleToInstallation: mockListReposAccessibleToInstallation,
      listInstallationRequestsForAuthenticatedApp: mockListInstallationRequests,
    },
    repos: {
      get: mockReposGet,
      getCollaboratorPermissionLevel: mockReposGetCollaboratorPermissionLevel,
      listBranches: mockReposListBranches,
    },
    pulls: { get: mockPullsGet, listCommits: mockPullsListCommits },
    paginate: mockPaginate,
    request: mockOctokitRequest,
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => mockInstallationAuth),
}));

jest.mock('../../github/runtime-authorization', () => ({
  GitHubRuntimeAuthorizationError: class GitHubRuntimeAuthorizationError extends Error {},
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
  fetchGitHubBranches,
  fetchGitHubInstallationRequests,
  fetchGitHubRepositories,
  fetchPullRequestByNumber,
  getCollaboratorPermissionLevel,
  GITHUB_LISTING_TIMEOUT_MS,
  GitHubCredentialRejectionError,
  GitHubListingBudgetExceededError,
  GitHubRateLimitError,
  isGitHubCredentialRejection,
  MAX_GITHUB_LISTING_BYTES,
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

/**
 * A page request that settles only when its budget aborts it, rejecting with the shape
 * @octokit/request's fetch wrapper produces for an abort: a `RequestError` 500 whose message is
 * the abort reason's and whose `cause` is that reason. The adapter must still report the typed
 * deadline error, whatever wrapper Octokit applies.
 */
function abortAsWrappedRequestError(signal: AbortSignal): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => {
    const requestError = new Error(String(signal.reason?.message ?? 'Internal Server Error'));
    requestError.name = 'HttpError';
    Object.assign(requestError, { status: 500, cause: signal.reason });
    reject(requestError);
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return promise;
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
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
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

  it('propagates the abort error when the token request times out', async () => {
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError'
    );
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(timeoutError);

    await expect(exchangeGitHubOAuthCode('auth-code', 'standard')).rejects.toBe(timeoutError);
  });

  it('authenticates the user with a bounded request', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(tokenResponse());

    await exchangeGitHubOAuthCode('auth-code', 'standard');

    expect(mockGetAuthenticated).toHaveBeenCalledWith({
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it('propagates a failure from the authenticated user lookup', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(tokenResponse());
    const lookupError = new Error('Bad credentials');
    mockGetAuthenticated.mockRejectedValueOnce(lookupError);

    await expect(exchangeGitHubOAuthCode('auth-code', 'standard')).rejects.toBe(lookupError);
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

describe('getCollaboratorPermissionLevel', () => {
  const fetchParams = ['5001', 'kilo', 'repo', 'octocat'] as const;

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

  it('returns a known permission from the collaborator lookup', async () => {
    mockReposGetCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'write' } });

    await expect(getCollaboratorPermissionLevel(...fetchParams)).resolves.toBe('write');
    expect(mockReposGetCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: 'kilo',
      repo: 'repo',
      username: 'octocat',
    });
  });

  it('mints the installation token before the collaborator lookup', async () => {
    mockReposGetCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'read' } });

    await getCollaboratorPermissionLevel(...fetchParams);

    expect(createAppAuth).toHaveBeenCalledWith(expect.objectContaining({ installationId: '5001' }));
  });

  it('rejects a mint 401 as the typed credential rejection', async () => {
    const mintError = httpError(401, "Kernel's GitHub App credentials were rejected");
    mockInstallationAuth.mockRejectedValue(mintError);

    const thrown: unknown = await getCollaboratorPermissionLevel(...fetchParams).catch(
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(GitHubCredentialRejectionError);
    expect(isGitHubCredentialRejection(thrown)).toBe(true);
    expect(thrown).toMatchObject({ message: "Kernel's GitHub App credentials were rejected" });
    expect((thrown as GitHubCredentialRejectionError).cause).toBe(mintError);
    expect(mockReposGetCollaboratorPermissionLevel).not.toHaveBeenCalled();
  });

  it('rethrows a lookup 401 raw so it stays retryable', async () => {
    const lookupError = httpError(401, 'Bad credentials');
    mockReposGetCollaboratorPermissionLevel.mockRejectedValue(lookupError);

    const thrown: unknown = await getCollaboratorPermissionLevel(...fetchParams).catch(
      (error: unknown) => error
    );

    expect(thrown).toBe(lookupError);
    expect(isGitHubCredentialRejection(thrown)).toBe(false);
  });

  it('returns null for an unknown collaborator', async () => {
    mockReposGetCollaboratorPermissionLevel.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 })
    );

    await expect(getCollaboratorPermissionLevel(...fetchParams)).resolves.toBeNull();
  });

  it('returns null when the mint reports the installation gone', async () => {
    mockInstallationAuth.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

    await expect(getCollaboratorPermissionLevel(...fetchParams)).resolves.toBeNull();
  });
});

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

type GitHubRepositoryRow = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  created_at?: string;
  archived?: boolean;
};

function repositoryRow(id: number, overrides: Partial<GitHubRepositoryRow> = {}) {
  return {
    id,
    name: `repo-${id}`,
    full_name: `kilo/repo-${id}`,
    private: false,
    created_at: '2026-01-01T00:00:00Z',
    archived: false,
    ...overrides,
  };
}

describe('fetchGitHubRepositories', () => {
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

  it('keeps the projection, the archived filter and the page walk for an ordinary installation', async () => {
    const firstPage = Array.from({ length: 100 }, (_value, index) => repositoryRow(index));
    firstPage[1] = repositoryRow(1, { archived: true });
    firstPage[5] = repositoryRow(5, { created_at: undefined });
    mockListReposAccessibleToInstallation
      .mockResolvedValueOnce({ data: { total_count: 150, repositories: firstPage } })
      .mockResolvedValueOnce({
        data: {
          total_count: 150,
          repositories: Array.from({ length: 50 }, (_value, index) =>
            repositoryRow(100 + index, { private: true })
          ),
        },
      });

    const repositories = await fetchGitHubRepositories('5001');

    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(2);
    expect(mockListReposAccessibleToInstallation).toHaveBeenLastCalledWith({
      per_page: 100,
      page: 2,
      request: { signal: expect.any(AbortSignal) },
    });
    // One archived row is dropped and nothing else changes.
    expect(repositories).toHaveLength(149);
    expect(repositories[0]).toEqual({
      id: 0,
      name: 'repo-0',
      full_name: 'kilo/repo-0',
      private: false,
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(repositories.some(repository => repository.id === 1)).toBe(false);
    expect(repositories.find(repository => repository.id === 5)?.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );
    expect(repositories[148]).toEqual({
      id: 149,
      name: 'repo-149',
      full_name: 'kilo/repo-149',
      private: true,
      created_at: '2026-01-01T00:00:00Z',
    });
  });

  it('rejects a listing whose full pages pass the page cap', async () => {
    mockListReposAccessibleToInstallation.mockResolvedValue({
      data: {
        total_count: 1_000_000,
        repositories: Array.from({ length: 100 }, (_value, index) => repositoryRow(index)),
      },
    });

    const thrown: unknown = await fetchGitHubRepositories('5001').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      'GitHub pagination limit exceeded: repository listing returned more than 100 pages'
    );
    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(100);
  });

  it('rejects a listing that returns more items than the item cap', async () => {
    mockListReposAccessibleToInstallation.mockResolvedValue({
      data: {
        total_count: 10_001,
        repositories: Array.from({ length: 10_001 }, (_value, index) => repositoryRow(index)),
      },
    });

    const thrown: unknown = await fetchGitHubRepositories('5001').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      'GitHub pagination limit exceeded: repository listing returned more than 10000 items'
    );
    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(1);
  });

  it('stops a read that exceeds the cumulative byte budget', async () => {
    const padding = 'x'.repeat(20_000);
    mockListReposAccessibleToInstallation.mockResolvedValue({
      data: {
        total_count: 1_000_000,
        repositories: Array.from({ length: 100 }, (_value, index) => ({
          ...repositoryRow(index),
          description: padding,
        })),
      },
    });

    const thrown: unknown = await fetchGitHubRepositories('5001').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      `GitHub pagination limit exceeded: repository listing returned more than ${MAX_GITHUB_LISTING_BYTES / (1024 * 1024)} MiB`
    );
    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(9);
  });

  it('covers every page of one read with the same deadline', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      mockListReposAccessibleToInstallation.mockImplementation(
        (params: { request: { signal: AbortSignal } }) => {
          const { signal } = params.request;
          signals.push(signal);
          if (signals.length === 1) {
            return Promise.resolve({
              data: {
                total_count: 200,
                repositories: Array.from({ length: 100 }, (_value, index) => repositoryRow(index)),
              },
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
        }
      );

      const read = fetchGitHubRepositories('5001');
      const settled = read.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: repository listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
      expect(signals).toHaveLength(2);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      // The abort reason is named AbortError so Octokit's fetch wrapper rethrows it, and it
      // carries the typed error the loops report.
      const [{ reason }] = signals;
      expect(reason.name).toBe('AbortError');
      expect(reason.message).toBe(
        `GitHub pagination limit exceeded: repository listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
      expect(reason.cause).toBeInstanceOf(GitHubListingBudgetExceededError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports the typed deadline error when Octokit wraps the aborted request', async () => {
    jest.useFakeTimers();
    try {
      mockListReposAccessibleToInstallation.mockImplementation(
        (params: { request: { signal: AbortSignal } }) =>
          abortAsWrappedRequestError(params.request.signal)
      );

      const read = fetchGitHubRepositories('5001');
      const settled = read.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: repository listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('rethrows a page failure that is not the deadline unchanged', async () => {
    const failure = Object.assign(new Error('Not Found'), { name: 'HttpError', status: 404 });
    mockListReposAccessibleToInstallation.mockRejectedValue(failure);

    const thrown: unknown = await fetchGitHubRepositories('5001').catch((error: unknown) => error);

    expect(thrown).toBe(failure);
    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(1);
  });
});

describe('fetchGitHubBranches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInstallationAuth.mockReset().mockResolvedValue({
      token: 'installation-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    mockReposGet.mockResolvedValue({ data: { default_branch: 'main' } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function branchNames(count: number, offset = 0) {
    return Array.from({ length: count }, (_value, index) => ({
      name: `branch-${offset + index}`,
    }));
  }

  it('marks the default branch and walks every page', async () => {
    mockReposListBranches
      .mockResolvedValueOnce({ data: [{ name: 'main' }, ...branchNames(99, 1)] })
      .mockResolvedValueOnce({ data: branchNames(20, 100) });

    const branches = await fetchGitHubBranches('5001', 'kilo/repo');

    expect(branches).toHaveLength(120);
    expect(branches[0]).toEqual({ name: 'main', isDefault: true });
    expect(branches[1]).toEqual({ name: 'branch-1', isDefault: false });
    expect(mockReposListBranches).toHaveBeenLastCalledWith({
      owner: 'kilo',
      repo: 'repo',
      per_page: 100,
      page: 2,
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it('rejects a listing whose full pages pass the page cap', async () => {
    mockReposListBranches.mockResolvedValue({ data: branchNames(100) });

    const thrown: unknown = await fetchGitHubBranches('5001', 'kilo/repo').catch(
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      'GitHub pagination limit exceeded: branch listing returned more than 100 pages'
    );
    expect(mockReposListBranches).toHaveBeenCalledTimes(100);
  });

  it('rejects a listing that returns more items than the item cap', async () => {
    mockReposListBranches.mockResolvedValue({ data: branchNames(10_001) });

    const thrown: unknown = await fetchGitHubBranches('5001', 'kilo/repo').catch(
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      'GitHub pagination limit exceeded: branch listing returned more than 10000 items'
    );
    expect(mockReposListBranches).toHaveBeenCalledTimes(1);
  });

  it('stops a read that exceeds the cumulative byte budget', async () => {
    const padding = 'x'.repeat(20_000);
    mockReposListBranches.mockResolvedValue({
      data: branchNames(100).map(branch => ({ ...branch, protection: { padding } })),
    });

    const thrown: unknown = await fetchGitHubBranches('5001', 'kilo/repo').catch(
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      `GitHub pagination limit exceeded: branch listing returned more than ${MAX_GITHUB_LISTING_BYTES / (1024 * 1024)} MiB`
    );
    expect(mockReposListBranches).toHaveBeenCalledTimes(9);
  });

  it('covers every page of one read with the same deadline', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      mockReposListBranches.mockImplementation((params: { request: { signal: AbortSignal } }) => {
        const { signal } = params.request;
        signals.push(signal);
        if (signals.length === 1) {
          return Promise.resolve({ data: branchNames(100) });
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

      const read = fetchGitHubBranches('5001', 'kilo/repo');
      const settled = read.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: branch listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
      expect(signals).toHaveLength(2);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      const [{ reason }] = signals;
      expect(reason.name).toBe('AbortError');
      expect(reason.message).toBe(
        `GitHub pagination limit exceeded: branch listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
      expect(reason.cause).toBeInstanceOf(GitHubListingBudgetExceededError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports the typed deadline error when Octokit wraps the aborted request', async () => {
    jest.useFakeTimers();
    try {
      mockReposListBranches.mockImplementation((params: { request: { signal: AbortSignal } }) =>
        abortAsWrappedRequestError(params.request.signal)
      );

      const read = fetchGitHubBranches('5001', 'kilo/repo');
      const settled = read.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: branch listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('fetchGitHubInstallationRequests', () => {
  function requestRow(id: number, overrides: Record<string, unknown> = {}) {
    return {
      id,
      account: { id: 900 + id, login: `account-${id}` },
      requester: { id: 700 + id, login: `requester-${id}` },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockInstallationAuth.mockReset().mockResolvedValue({
      token: 'app-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps every pending request across pages', async () => {
    mockListInstallationRequests
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_value, index) => requestRow(index)),
      })
      .mockResolvedValueOnce({
        data: [requestRow(100, { account: { id: 5, slug: 'from-a-slug' }, requester: null })],
      });

    const requests = await fetchGitHubInstallationRequests();

    expect(requests).toHaveLength(101);
    expect(requests[0]).toEqual({
      id: '0',
      accountId: '900',
      accountLogin: 'account-0',
      requesterId: '700',
      requesterLogin: 'requester-0',
    });
    expect(requests[100]).toEqual({
      id: '100',
      accountId: '5',
      accountLogin: 'from-a-slug',
      requesterId: null,
      requesterLogin: null,
    });
    expect(mockListInstallationRequests).toHaveBeenLastCalledWith({
      per_page: 100,
      page: 2,
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it('rejects a listing whose full pages pass the page cap', async () => {
    mockListInstallationRequests.mockResolvedValue({
      data: Array.from({ length: 100 }, (_value, index) => requestRow(index)),
    });

    const thrown: unknown = await fetchGitHubInstallationRequests().catch(
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      'GitHub pagination limit exceeded: installation request listing returned more than 100 pages'
    );
    expect(mockListInstallationRequests).toHaveBeenCalledTimes(100);
  });

  it('reports the typed deadline error when the read runs out of time', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      mockListInstallationRequests.mockImplementation(
        (params: { request: { signal: AbortSignal } }) => {
          const { signal } = params.request;
          signals.push(signal);
          if (signals.length === 1) {
            return Promise.resolve({ data: Array.from({ length: 100 }, (_v, i) => requestRow(i)) });
          }
          const { promise, reject } = Promise.withResolvers<never>();
          const abort = () => reject(signal.reason);
          if (signal.aborted) {
            abort();
            return promise;
          }
          signal.addEventListener('abort', abort, { once: true });
          return promise;
        }
      );

      const read = fetchGitHubInstallationRequests();
      const settled = read.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: installation request listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
      expect(signals).toHaveLength(2);
      const [{ reason }] = signals;
      expect(reason.name).toBe('AbortError');
      expect(reason.cause).toBeInstanceOf(GitHubListingBudgetExceededError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports the typed deadline error when Octokit wraps the aborted request', async () => {
    jest.useFakeTimers();
    try {
      mockListInstallationRequests.mockImplementation(
        (params: { request: { signal: AbortSignal } }) =>
          abortAsWrappedRequestError(params.request.signal)
      );

      const read = fetchGitHubInstallationRequests();
      const settled = read.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: installation request listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
