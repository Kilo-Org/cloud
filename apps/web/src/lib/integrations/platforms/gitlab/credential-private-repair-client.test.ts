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

import { requestGitLabCredentialPrivateRepair } from './credential-private-repair-client';

const successfulRepair = {
  counts: {
    candidates: 1,
    repaired: 1,
    alreadyHealthy: 0,
    profileFailures: 0,
    configurationFailures: 0,
    parseFailures: 0,
    unknownKeyFailures: 0,
    unrepairableFailures: 0,
    writeConflicts: 0,
  },
  failures: {
    profile: [],
    configuration: [],
    parse: [],
    unknownKey: [],
    unrepairable: [],
    writeConflict: [],
  },
  nextCursor: null,
};

describe('GitLab credential private repair client', () => {
  afterEach(() => {
    config.url = 'https://git-token-service.test';
    mockGenerateInternalServiceToken.mockClear();
    jest.restoreAllMocks();
  });

  it('uses the repair audience and validates a bounded successful response', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(successfulRepair), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      requestGitLabCredentialPrivateRepair({
        requestedByUserId: 'admin-user',
        afterId: null,
        limit: 10,
      })
    ).resolves.toEqual({ kind: 'success', repair: successfulRepair });
    expect(mockGenerateInternalServiceToken).toHaveBeenCalledWith('admin-user', {
      audience: 'git-token-service:gitlab-credential-repair',
      expiresIn: 300,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://git-token-service.test/internal/gitlab/credential-repair',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ limit: 10 }),
      })
    );
  });

  it('does not advance work on transient failures', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      requestGitLabCredentialPrivateRepair({ requestedByUserId: 'admin-user', afterId: null })
    ).resolves.toEqual({ kind: 'retryable_error', errorCode: 'repair_unavailable' });
  });
});
