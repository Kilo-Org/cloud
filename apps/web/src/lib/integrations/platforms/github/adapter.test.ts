const mockGetAuthenticated = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: { users: { getAuthenticated: mockGetAuthenticated } },
  })),
}));

jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: () => ({
    clientId: 'github-client-id',
    clientSecret: 'github-client-secret',
  }),
}));

import { exchangeGitHubOAuthCode } from './adapter';

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
});
