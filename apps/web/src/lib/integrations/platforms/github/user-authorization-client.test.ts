import { disconnectStoredGitHubUserAuthorization } from './user-authorization-client';

const mockConfig = {
  apiUrl: 'https://git-token-service.example.com',
};
const mockGenerateInternalServiceToken = jest.fn(
  (userId: string, _options?: { expiresIn?: number }) => `short-lived-user-token:${userId}`
);

jest.mock('@/lib/config.server', () => ({
  get GIT_TOKEN_SERVICE_API_URL() {
    return mockConfig.apiUrl;
  },
}));

jest.mock('@/lib/tokens', () => ({
  TOKEN_EXPIRY: { fiveMinutes: 5 * 60 },
  generateInternalServiceToken: (userId: string, options?: { expiresIn?: number }) =>
    mockGenerateInternalServiceToken(userId, options),
}));

describe('disconnectStoredGitHubUserAuthorization', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockConfig.apiUrl = 'https://git-token-service.example.com';
    mockGenerateInternalServiceToken.mockClear();
  });

  it('authenticates disconnect using a short-lived user-scoped token', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ disconnected: true }), { status: 200 }));

    await disconnectStoredGitHubUserAuthorization('kilo-user-1');

    expect(mockGenerateInternalServiceToken).toHaveBeenCalledWith('kilo-user-1', {
      expiresIn: 5 * 60,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://git-token-service.example.com/internal/github-user-authorizations/disconnect',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer short-lived-user-token:kilo-user-1' },
      }
    );
  });

  it('fails without making a request when service configuration is unavailable', async () => {
    mockConfig.apiUrl = '';
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(disconnectStoredGitHubUserAuthorization('kilo-user-1')).rejects.toThrow(
      'Git token service disconnect is not configured'
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes transport failures without propagating internal request details', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('internal service URL failed'));

    await expect(disconnectStoredGitHubUserAuthorization('kilo-user-1')).rejects.toThrow(
      'GitHub authorization disconnect request failed'
    );
  });

  it('reports service failures without returning response bodies', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('credential details must not propagate', {
        status: 503,
        statusText: 'Unavailable',
      })
    );

    await expect(disconnectStoredGitHubUserAuthorization('kilo-user-1')).rejects.toThrow(
      'GitHub authorization disconnect failed (503)'
    );
  });
});
