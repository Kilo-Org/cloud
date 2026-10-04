const mockGetAuthenticated = jest.fn();
const mockPullsGet = jest.fn();
const mockPullsListCommits = jest.fn();
const mockPaginate = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: { users: { getAuthenticated: mockGetAuthenticated } },
    pulls: { get: mockPullsGet, listCommits: mockPullsListCommits },
    paginate: mockPaginate,
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({
    token: 'installation-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  })),
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

import { exchangeGitHubOAuthCode, fetchPullRequestByNumber } from './adapter';
import { verifySessionPullRequestLink } from './pr-link-identity';

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
    base: { repo: { full_name: 'kilo/repo' } },
    updated_at: '2026-01-01T00:00:00Z',
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

describe('fetchPullRequestByNumber', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      baseRepoFullName: 'kilo/repo',
      headRepoFullName: 'kilo/repo',
      headRef: 'feature/z',
    });
    expect(mockPullsGet).toHaveBeenCalledWith({ owner: 'kilo', repo: 'repo', pull_number: 7 });
    expect(mockPaginate).not.toHaveBeenCalled();
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
