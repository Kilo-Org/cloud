const config = { url: 'https://git-token-service.test' };
const mockGenerateInternalServiceToken = jest.fn(
  (_userId: string, _options: { expiresIn: number; audience: string }) => 'internal-token'
);

jest.mock('@/lib/config.server', () => ({
  get GIT_TOKEN_SERVICE_API_URL() {
    return config.url;
  },
}));
jest.mock('@/lib/tokens', () => ({
  TOKEN_EXPIRY: { fiveMinutes: 300 },
  generateInternalServiceToken: (
    userId: string,
    options: { expiresIn: number; audience: string }
  ) => mockGenerateInternalServiceToken(userId, options),
}));

import { requestGitLabCredentialPrivateAudit } from './credential-private-audit-client';

const successfulAudit = {
  activeKey: {
    keyId: 'credential-key-v1',
    publicKeySha256: 'a'.repeat(64),
  },
  counts: {
    credentials: 1,
    secrets: 1,
    passedCredentials: 1,
    profileFailures: 0,
    configurationFailures: 0,
    parseFailures: 0,
    unknownKeyFailures: 0,
    decryptOrAadFailures: 0,
  },
  failingCredentials: {
    profile: [],
    configuration: [],
    parse: [],
    unknownKey: [],
    decryptOrAad: [],
  },
  nextCursor: null,
};

describe('GitLab credential private audit client', () => {
  afterEach(() => {
    config.url = 'https://git-token-service.test';
    mockGenerateInternalServiceToken.mockClear();
    jest.restoreAllMocks();
  });

  it('uses the dedicated audience and validates a bounded successful response', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(successfulAudit), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      requestGitLabCredentialPrivateAudit({ requestedByUserId: 'admin-user', cursor: null })
    ).resolves.toEqual({ kind: 'success', audit: successfulAudit });
    expect(mockGenerateInternalServiceToken).toHaveBeenCalledWith('admin-user', {
      audience: 'git-token-service:gitlab-credential-audit',
      expiresIn: 300,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://git-token-service.test/internal/gitlab/credential-audit',
      expect.objectContaining({ method: 'POST', redirect: 'error' })
    );
  });

  it.each([
    [401, 'audit_unauthorized'],
    [403, 'requester_not_admin'],
  ])('treats %i as a terminal %s failure', async (status, errorCode) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status }));

    await expect(
      requestGitLabCredentialPrivateAudit({ requestedByUserId: 'admin-user', cursor: null })
    ).resolves.toEqual({ kind: 'terminal_error', errorCode });
  });

  it('does not advance work on transient failures', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      requestGitLabCredentialPrivateAudit({ requestedByUserId: 'admin-user', cursor: 'oauth:abc' })
    ).resolves.toEqual({ kind: 'retryable_error', errorCode: 'audit_unavailable' });
  });
});
