import {
  fetchGitLabCredential,
  GitLabCredentialBrokerResultSchema,
} from './credential-broker-client';

const mockConfig = { apiUrl: 'https://git-token-service.example.com' };
const mockGenerateInternalServiceToken = jest.fn(
  (userId: string, _options: { expiresIn: number; audience: string; organizationId?: string }) =>
    `broker-token:${userId}`
);

jest.mock('@/lib/config.server', () => ({
  get GIT_TOKEN_SERVICE_API_URL() {
    return mockConfig.apiUrl;
  },
}));

jest.mock('@/lib/tokens', () => ({
  TOKEN_EXPIRY: { fiveMinutes: 5 * 60 },
  generateInternalServiceToken: (
    userId: string,
    options: { expiresIn: number; audience: string; organizationId?: string }
  ) => mockGenerateInternalServiceToken(userId, options),
}));

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

describe('fetchGitLabCredential', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockConfig.apiUrl = 'https://git-token-service.example.com';
    mockGenerateInternalServiceToken.mockClear();
  });

  it('uses a purpose-bound actor token and posts the strict integration selector', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        status: 'available',
        token: 'glpat-integration-token',
        instanceUrl: 'https://gitlab.example.com',
        glabIsOAuth2: false,
      })
    );
    const result = await fetchGitLabCredential(
      { userId: 'user-1', organizationId: '11111111-1111-4111-8111-111111111111' },
      { credential: 'integration', integrationId: '22222222-2222-4222-8222-222222222222' }
    );

    expect(mockGenerateInternalServiceToken).toHaveBeenCalledWith('user-1', {
      expiresIn: 5 * 60,
      audience: 'git-token-service:gitlab-credentials',
      organizationId: '11111111-1111-4111-8111-111111111111',
    });
    expect(result).toEqual({
      status: 'available',
      token: 'glpat-integration-token',
      instanceUrl: 'https://gitlab.example.com',
      glabIsOAuth2: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://git-token-service.example.com/internal/gitlab/credentials',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer broker-token:user-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          credential: 'integration',
          integrationId: '22222222-2222-4222-8222-222222222222',
        }),
        redirect: 'error',
        signal: expect.anything(),
      })
    );
  });

  it('posts only the exact requested project selector', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ status: 'not_connected' }));

    await fetchGitLabCredential(
      { userId: 'user-1' },
      {
        credential: 'project-exact',
        integrationId: '22222222-2222-4222-8222-222222222222',
        projectId: '42',
      }
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      credential: 'project-exact',
      integrationId: '22222222-2222-4222-8222-222222222222',
      projectId: '42',
    });
  });

  it('fails closed when service configuration is unavailable', async () => {
    mockConfig.apiUrl = '';
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(
      fetchGitLabCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: '22222222-2222-4222-8222-222222222222' }
      )
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an extra response field', jsonResponse({ status: 'not_connected', detail: 'secret' })],
    [
      'an oversized response',
      jsonResponse(
        { status: 'temporarily_unavailable' },
        { headers: { 'Content-Length': '65536' } }
      ),
    ],
    ['a non-JSON response', new Response('unavailable', { status: 200 })],
  ])('maps %s to temporary unavailability', async (_name, response) => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(response);

    await expect(
      fetchGitLabCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: '22222222-2222-4222-8222-222222222222' }
      )
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
  });
});

describe('GitLabCredentialBrokerResultSchema', () => {
  it.each([
    'invalid_request',
    'not_connected',
    'reconnect_required',
    'temporarily_unavailable',
  ] as const)('accepts the strict %s result', status => {
    expect(GitLabCredentialBrokerResultSchema.parse({ status })).toEqual({ status });
  });
});
