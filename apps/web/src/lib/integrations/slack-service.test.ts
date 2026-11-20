process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

const mockLimit = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateReturning = jest.fn();
const mockDeleteWhere = jest.fn();
const mockDeleteReturning = jest.fn();
const mockInsertValues = jest.fn();
const mockInsertReturning = jest.fn();
const mockAuthRevoke = jest.fn();
const mockAuthTest = jest.fn();
const mockTransaction = jest.fn();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({ limit: mockLimit })),
          limit: mockLimit,
        })),
      })),
    })),
    delete: jest.fn(() => ({
      where: mockDeleteWhere,
    })),
    update: jest.fn(() => ({
      set: mockUpdateSet,
    })),
    insert: jest.fn(() => ({
      values: mockInsertValues,
    })),
    // Accessed lazily: jest.mock factories hoist above the const declarations.
    get transaction() {
      return mockTransaction;
    },
  },
}));

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn(() => ({
    auth: {
      revoke: mockAuthRevoke,
      test: mockAuthTest,
    },
  })),
}));

const mockWriteSlackCredential = jest.fn();
const mockGetSlackCredentialByIntegrationId = jest.fn();
const mockDecryptSlackBotToken = jest.fn();
jest.mock('@/lib/integrations/platforms/slack/credential-store', () => ({
  writeSlackCredential: (...args: unknown[]) => mockWriteSlackCredential(...args),
  getSlackCredentialByIntegrationId: (...args: unknown[]) =>
    mockGetSlackCredentialByIntegrationId(...args),
  decryptSlackBotToken: (...args: unknown[]) => mockDecryptSlackBotToken(...args),
}));

const mockGetDefaultAllowedModel = jest.fn();
jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: (...args: unknown[]) => mockGetDefaultAllowedModel(...args),
}));

const mockCaptureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { WebClient: MockWebClient } = jest.requireMock<{ WebClient: jest.Mock }>('@slack/web-api');

import type { Owner } from '@/lib/integrations/core/types';
import type { SlackInstallation } from '@chat-adapter/slack';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { SLACK_DISCONNECT_UNCONFIRMED_MESSAGE } from '@kilocode/app-shared/integrations-errors';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { SlackCredentialDecryptionError } from '@/lib/integrations/platforms/slack/credential-encryption';
import {
  deleteInstallationByTeamId,
  getMissingSlackScopes,
  readSlackBotToken,
  revokeSlackToken,
  SlackWorkspaceAlreadyConnectedError,
  SlackWorkspaceRebindNotAllowedError,
  SLACK_SCOPES,
  testConnection,
  uninstallApp,
  upsertSlackInstallation,
} from './slack-service';

const owner = { type: 'user', id: 'user-1' } satisfies Owner;
const orgOwner = { type: 'org', id: 'org-1' } satisfies Owner;

// The revoke path reports failures on purpose; no test may inherit that call count.
afterEach(() => {
  mockCaptureException.mockReset();
});

function buildSlackIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'integration-1',
    integration_status: 'active',
    metadata: { access_token: 'xoxb-token' },
    platform_installation_id: 'T123',
    platform_account_id: 'T123',
    owned_by_user_id: owner.id,
    owned_by_organization_id: null,
    ...overrides,
  };
}

describe('slack-service uninstallApp', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockDeleteWhere.mockReset();
    mockAuthRevoke.mockReset();
    mockGetSlackCredentialByIntegrationId.mockReset();
    mockDecryptSlackBotToken.mockReset();
    mockAuthRevoke.mockResolvedValue({ ok: true });
    mockGetSlackCredentialByIntegrationId.mockResolvedValue({ id: 'credential-1' });
    mockDecryptSlackBotToken.mockReturnValue('xoxb-token');
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateReturning.mockResolvedValue([buildSlackIntegration()]);
    mockDeleteWhere.mockResolvedValue(undefined);
  });

  it('deletes Chat SDK Slack state before removing the platform integration row', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {});

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).resolves.toEqual({
      success: true,
    });

    expect(deleteChatSdkInstallation).toHaveBeenCalledWith('T123');
    expect(deleteChatSdkIdentityCache).toHaveBeenCalledWith('T123');
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(deleteChatSdkInstallation.mock.invocationCallOrder[0]).toBeLessThan(
      deleteChatSdkIdentityCache.mock.invocationCallOrder[0]
    );
    expect(deleteChatSdkIdentityCache.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteWhere.mock.invocationCallOrder[0]
    );
  });

  it('does not remove the platform integration row when Chat SDK installation cleanup fails', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {
      throw new Error('redis unavailable');
    });

    await expect(uninstallApp(owner, { deleteChatSdkInstallation })).rejects.toThrow(
      'redis unavailable'
    );

    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('does not remove the platform integration row when Chat SDK identity cleanup fails', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {
      throw new Error('redis unavailable');
    });

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).rejects.toThrow('redis unavailable');

    expect(deleteChatSdkInstallation).toHaveBeenCalledWith('T123');
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('falls back to the platform account ID for older rows without an installation ID', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({ platform_installation_id: null, platform_account_id: 'T456' }),
    ]);
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});

    await uninstallApp(owner, { deleteChatSdkInstallation });

    expect(deleteChatSdkInstallation).toHaveBeenCalledWith('T456');
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it('revokes the credential-store token for an active integration', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);

    await expect(uninstallApp(owner)).resolves.toEqual({ success: true });

    expect(mockGetSlackCredentialByIntegrationId).toHaveBeenCalledWith('integration-1');
    expect(mockDecryptSlackBotToken).toHaveBeenCalledWith({ id: 'credential-1' }, owner);
    expect(mockAuthRevoke).toHaveBeenCalledTimes(1);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it('disconnects suspended integrations without deleting shared Slack installation state', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({
        integration_status: 'suspended',
        platform_installation_id: null,
        platform_account_id: 'T456',
      }),
    ]);
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {});

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).resolves.toEqual({ success: true });

    expect(mockAuthRevoke).not.toHaveBeenCalled();
    expect(deleteChatSdkInstallation).not.toHaveBeenCalled();
    expect(deleteChatSdkIdentityCache).not.toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it('removes the platform integration row when Slack reports the token already invalid', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockAuthRevoke.mockRejectedValue({
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'invalid_auth' },
    });

    await expect(uninstallApp(owner)).resolves.toEqual({ success: true });

    expect(mockAuthRevoke).toHaveBeenCalledTimes(1);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it('keeps the platform integration row when the Slack revoke request is rate limited', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockAuthRevoke.mockRejectedValue({ code: 'slack_webapi_rate_limited_error', retryAfter: 30 });
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {});

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: SLACK_DISCONNECT_UNCONFIRMED_MESSAGE,
    });

    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(deleteChatSdkInstallation).not.toHaveBeenCalled();
    expect(deleteChatSdkIdentityCache).not.toHaveBeenCalled();
  });

  it('keeps the platform integration row when a platform error is not a terminal token code', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockAuthRevoke.mockRejectedValue({
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'something_else' },
    });
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {});

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: SLACK_DISCONNECT_UNCONFIRMED_MESSAGE,
    });

    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(deleteChatSdkInstallation).not.toHaveBeenCalled();
    expect(deleteChatSdkIdentityCache).not.toHaveBeenCalled();
  });

  it('keeps the platform integration row when the stored credential cannot be read', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockGetSlackCredentialByIntegrationId.mockRejectedValue(new Error('database is down'));
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {});

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: SLACK_DISCONNECT_UNCONFIRMED_MESSAGE,
    });

    expect(mockAuthRevoke).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(deleteChatSdkInstallation).not.toHaveBeenCalled();
    expect(deleteChatSdkIdentityCache).not.toHaveBeenCalled();
  });

  it('keeps the platform integration row when the stored credential cannot be decrypted', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockDecryptSlackBotToken.mockImplementation(() => {
      throw new SlackCredentialDecryptionError('access');
    });
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {});

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: SLACK_DISCONNECT_UNCONFIRMED_MESSAGE,
    });

    expect(mockAuthRevoke).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(deleteChatSdkInstallation).not.toHaveBeenCalled();
    expect(deleteChatSdkIdentityCache).not.toHaveBeenCalled();
  });

  it('removes the platform integration row when no credential was ever stored', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockGetSlackCredentialByIntegrationId.mockResolvedValue(null);

    await expect(uninstallApp(owner)).resolves.toEqual({ success: true });

    expect(mockAuthRevoke).not.toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });
});

describe('slack-service readSlackBotToken', () => {
  beforeEach(() => {
    mockGetSlackCredentialByIntegrationId.mockReset();
    mockDecryptSlackBotToken.mockReset();
    mockGetSlackCredentialByIntegrationId.mockResolvedValue({ id: 'credential-1' });
    mockDecryptSlackBotToken.mockReturnValue('xoxb-token');
  });

  it('returns the token when the stored credential decrypts', async () => {
    const read = await readSlackBotToken(buildSlackIntegration() as PlatformIntegration);

    expect(read).toEqual({ status: 'available', token: 'xoxb-token' });
    expect(mockDecryptSlackBotToken).toHaveBeenCalledWith({ id: 'credential-1' }, owner);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('reports absent when no credential row exists', async () => {
    mockGetSlackCredentialByIntegrationId.mockResolvedValue(null);

    const read = await readSlackBotToken(buildSlackIntegration() as PlatformIntegration);

    expect(read).toEqual({ status: 'absent' });
    expect(mockDecryptSlackBotToken).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('reports absent when the stored credential row is already revoked', async () => {
    mockDecryptSlackBotToken.mockReturnValue(null);

    const read = await readSlackBotToken(buildSlackIntegration() as PlatformIntegration);

    expect(read).toEqual({ status: 'absent' });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('reports a read failure when the credential row cannot be loaded', async () => {
    const failure = new Error('database is down');
    mockGetSlackCredentialByIntegrationId.mockRejectedValue(failure);

    const read = await readSlackBotToken(buildSlackIntegration() as PlatformIntegration);

    expect(read).toEqual({ status: 'unavailable', reason: 'read_failed' });
    expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything());
  });

  it('reports a decrypt failure when the stored credential cannot be decrypted', async () => {
    const failure = new SlackCredentialDecryptionError('access');
    mockDecryptSlackBotToken.mockImplementation(() => {
      throw failure;
    });

    const read = await readSlackBotToken(buildSlackIntegration() as PlatformIntegration);

    expect(read).toEqual({ status: 'unavailable', reason: 'decrypt_failed' });
    expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything());
  });

  it('reports a read failure when the row has no exclusive owner', async () => {
    const read = await readSlackBotToken(
      buildSlackIntegration({
        owned_by_user_id: null,
        owned_by_organization_id: null,
      }) as PlatformIntegration
    );

    expect(read).toEqual({ status: 'unavailable', reason: 'read_failed' });
    expect(mockGetSlackCredentialByIntegrationId).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

describe('slack-service revokeSlackToken', () => {
  beforeEach(() => {
    mockAuthRevoke.mockReset();
    mockCaptureException.mockReset();
    MockWebClient.mockClear();
  });

  it('bounds the SDK retry policy so the disconnect cannot outlast the request timeout', async () => {
    mockAuthRevoke.mockResolvedValue({ ok: true });

    await revokeSlackToken('xoxb-token');

    expect(MockWebClient).toHaveBeenCalledTimes(1);
    const [token, options] = MockWebClient.mock.calls[0] as [
      string,
      { retryConfig: { retries: number } },
    ];
    expect(token).toBe('xoxb-token');
    expect(options.retryConfig.retries).toBe(1);
  });

  it('reports revoked when Slack accepts the revoke', async () => {
    mockAuthRevoke.mockResolvedValue({ ok: true });

    await expect(revokeSlackToken('xoxb-token')).resolves.toEqual({ status: 'revoked' });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it.each(['token_revoked', 'invalid_auth', 'not_authed', 'account_inactive', 'token_expired'])(
    'reports already_invalid when Slack rejects the token with %s',
    async slackError => {
      mockAuthRevoke.mockRejectedValue({
        code: 'slack_webapi_platform_error',
        data: { ok: false, error: slackError },
      });

      await expect(revokeSlackToken('xoxb-token')).resolves.toEqual({
        status: 'already_invalid',
        slackError,
      });
      expect(mockCaptureException).not.toHaveBeenCalled();
    }
  );

  it('reports a temporary failure when the revoke is rate limited', async () => {
    mockAuthRevoke.mockRejectedValue({ code: 'slack_webapi_rate_limited_error', retryAfter: 30 });

    await expect(revokeSlackToken('xoxb-token')).resolves.toEqual({
      status: 'temporary_failure',
      reason: 'rate_limited',
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('reports a temporary failure when Slack answers with an HTTP error', async () => {
    mockAuthRevoke.mockRejectedValue({ code: 'slack_webapi_http_error', statusCode: 503 });

    await expect(revokeSlackToken('xoxb-token')).resolves.toEqual({
      status: 'temporary_failure',
      reason: 'http_error',
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('reports a temporary failure when the request fails in transport', async () => {
    mockAuthRevoke.mockRejectedValue({
      code: 'slack_webapi_request_error',
      original: new Error('socket hang up'),
    });

    await expect(revokeSlackToken('xoxb-token')).resolves.toEqual({
      status: 'temporary_failure',
      reason: 'network',
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('reports a temporary failure when a platform error is not a terminal token code', async () => {
    mockAuthRevoke.mockRejectedValue({
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'something_else' },
    });

    await expect(revokeSlackToken('xoxb-token')).resolves.toEqual({
      status: 'temporary_failure',
      reason: 'unknown',
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockCaptureException.mock.calls[0])).not.toContain('xoxb-token');
  });
});

describe('slack-service deleteInstallationByTeamId', () => {
  beforeEach(() => {
    mockDeleteWhere.mockReset();
    mockDeleteReturning.mockReset();
    mockDeleteWhere.mockReturnValue({ returning: mockDeleteReturning });
  });

  it('reports a deleted workspace when rows are removed', async () => {
    mockDeleteReturning.mockResolvedValue([{ id: 'integration-1' }]);

    await expect(deleteInstallationByTeamId('T123')).resolves.toEqual({
      success: true,
      deleted: true,
    });

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });
});

describe('slack-service testConnection', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockAuthTest.mockReset();
    mockGetSlackCredentialByIntegrationId.mockReset();
    mockDecryptSlackBotToken.mockReset();
    mockGetSlackCredentialByIntegrationId.mockResolvedValue({ id: 'credential-1' });
    mockDecryptSlackBotToken.mockReturnValue('xoxb-token');
  });

  it('returns success when auth.test succeeds', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockAuthTest.mockResolvedValue({ ok: true });

    await expect(testConnection(owner)).resolves.toEqual({ success: true });
    expect(mockAuthTest).toHaveBeenCalledTimes(1);
  });

  it('returns failure when there is no Slack installation', async () => {
    mockLimit.mockResolvedValue([]);

    await expect(testConnection(owner)).resolves.toEqual({
      success: false,
      error: 'No Slack installation found',
    });
    expect(mockAuthTest).not.toHaveBeenCalled();
  });

  it('reads the token from the encrypted credential store', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration({ metadata: {} })]);
    mockAuthTest.mockResolvedValue({ ok: true });

    await expect(testConnection(owner)).resolves.toEqual({ success: true });
    expect(mockGetSlackCredentialByIntegrationId).toHaveBeenCalledWith('integration-1');
    expect(mockDecryptSlackBotToken).toHaveBeenCalledWith({ id: 'credential-1' }, owner);
  });

  it('returns failure when no credential row exists', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration({ metadata: {} })]);
    mockGetSlackCredentialByIntegrationId.mockResolvedValue(null);

    await expect(testConnection(owner)).resolves.toEqual({
      success: false,
      error: 'No access token found',
    });
    expect(mockAuthTest).not.toHaveBeenCalled();
  });

  it('returns failure when the credential cannot be decrypted', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration({ metadata: {} })]);
    mockDecryptSlackBotToken.mockImplementation(() => {
      throw new SlackCredentialDecryptionError('access');
    });

    await expect(testConnection(owner)).resolves.toEqual({
      success: false,
      error: 'No access token found',
    });
    expect(mockAuthTest).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockCaptureException.mock.calls[0])).not.toContain('xoxb-token');
  });

  it('returns the Slack error when auth.test rejects the token', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockAuthTest.mockResolvedValue({ ok: false, error: 'invalid_auth' });

    await expect(testConnection(owner)).resolves.toEqual({
      success: false,
      error: 'invalid_auth',
    });
  });

  it('returns a failure when the Slack client throws', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);
    mockAuthTest.mockRejectedValue(new Error('network down'));

    await expect(testConnection(owner)).resolves.toEqual({
      success: false,
      error: 'network down',
    });
  });
});

describe('getMissingSlackScopes', () => {
  it('returns scopes required by the app but missing from the installation', () => {
    const [missingScope, ...installedScopes] = SLACK_SCOPES;

    expect(getMissingSlackScopes(installedScopes)).toEqual([missingScope]);
  });

  it('returns an empty list when all required scopes are installed', () => {
    expect(getMissingSlackScopes([...SLACK_SCOPES])).toEqual([]);
  });
});

describe('upsertSlackInstallation', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    // A workspace lookup the test does not script finds no row.
    mockLimit.mockResolvedValue([]);
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateReturning.mockResolvedValue([buildSlackIntegration()]);
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([buildSlackIntegration()]);
    mockWriteSlackCredential.mockReset();
    mockGetSlackCredentialByIntegrationId.mockReset();
    mockDecryptSlackBotToken.mockReset();
    mockWriteSlackCredential.mockResolvedValue({ id: 'credential-1' });
    mockCaptureException.mockReset();
    // The upsert wraps both writes in one transaction and awaits its callback.
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          update: () => ({ set: mockUpdateSet }),
          insert: () => ({ values: mockInsertValues }),
        })
    );
    mockGetDefaultAllowedModel.mockReset();
  });

  it('preserves the selected model when refreshing an existing installation', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({
        metadata: {
          access_token: 'xoxb-old-token',
          bot_user_id: 'U_OLD_BOT',
          incoming_webhook: { channel: '#general', channelId: 'C123', url: 'https://example.com' },
          model_slug: 'anthropic/claude-sonnet-4.5',
        },
      }),
    ]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          bot_user_id: 'U_NEW_BOT',
          incoming_webhook: { channel: '#general', channelId: 'C123', url: 'https://example.com' },
          model_slug: 'anthropic/claude-sonnet-4.5',
        },
        platform_installation_id: 'T123',
      })
    );
  });

  it('uses the bot default model for new personal installations', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          bot_user_id: 'U_NEW_BOT',
          model_slug: DEFAULT_BOT_MODEL,
        }),
      })
    );
    const insertedMetadata = mockInsertValues.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(insertedMetadata).not.toHaveProperty('access_token');
  });

  it('stores no model for a new organization installation when the policy allows none', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockGetDefaultAllowedModel.mockResolvedValue(null);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner: orgOwner, teamId: 'T123', installation });

    expect(mockGetDefaultAllowedModel).toHaveBeenCalledWith(orgOwner.id, DEFAULT_BOT_MODEL);
    const inserted = mockInsertValues.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect('model_slug' in inserted.metadata).toBe(false);
    expect(inserted.metadata).toEqual({ bot_user_id: 'U_NEW_BOT' });
  });

  it('stores the allowed model for a new organization installation', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockGetDefaultAllowedModel.mockResolvedValue('test/allowed-model');

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner: orgOwner, teamId: 'T123', installation });

    const inserted = mockInsertValues.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(inserted.metadata.model_slug).toBe('test/allowed-model');
  });

  it('drops a non-string stored model value on reinstall', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({
        owned_by_user_id: null,
        owned_by_organization_id: orgOwner.id,
        metadata: { access_token: 'xoxb-old-token', model_slug: 42 },
      }),
    ]);
    mockGetDefaultAllowedModel.mockResolvedValue(null);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner: orgOwner, teamId: 'T123', installation });

    const updated = mockUpdateSet.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect('model_slug' in updated.metadata).toBe(false);
    expect('access_token' in updated.metadata).toBe(false);
  });

  it('preserves the selected model on reinstall', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({
        owned_by_user_id: null,
        owned_by_organization_id: orgOwner.id,
        metadata: { access_token: 'xoxb-old-token', model_slug: 'anthropic/claude-sonnet-4.5' },
      }),
    ]);
    mockGetDefaultAllowedModel.mockResolvedValue(null);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner: orgOwner, teamId: 'T123', installation });

    const updated = mockUpdateSet.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(updated.metadata.model_slug).toBe('anthropic/claude-sonnet-4.5');
  });

  it('rejects installing a Slack workspace connected to another owner', async () => {
    mockLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([buildSlackIntegration({ owned_by_user_id: 'user-2' })]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await expect(upsertSlackInstallation({ owner, teamId: 'T123', installation })).rejects.toThrow(
      SlackWorkspaceAlreadyConnectedError
    );

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('maps Slack workspace unique violations to a helpful install error', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockInsertReturning.mockRejectedValue({
      constraint: 'UQ_platform_integrations_slack_platform_inst',
    });

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await expect(upsertSlackInstallation({ owner, teamId: 'T123', installation })).rejects.toThrow(
      'Kilo Team is already connected to another Kilo account or organization'
    );
  });

  it('writes the bot token into the encrypted credential store on a new install', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockWriteSlackCredential).toHaveBeenCalledWith(
      {
        integrationId: 'integration-1',
        slackTeamId: 'T123',
        owner,
        botToken: 'xoxb-new-token',
        botUserId: 'U_NEW_BOT',
      },
      expect.objectContaining({ insert: expect.any(Function) })
    );
  });

  it('writes the bot token into the credential store when refreshing an existing install', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);

    const installation = {
      botToken: 'xoxb-rotated-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockWriteSlackCredential).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: 'xoxb-rotated-token', slackTeamId: 'T123' }),
      expect.objectContaining({ update: expect.any(Function) })
    );
  });

  // A failed credential write fails the install.
  it('fails the install when the credential store write fails', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockWriteSlackCredential.mockRejectedValue(new Error('encryption not configured'));

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await expect(upsertSlackInstallation({ owner, teamId: 'T123', installation })).rejects.toThrow(
      'encryption not configured'
    );
  });
});

describe('upsertSlackInstallation organization workspace binding', () => {
  const organizationOwner = { type: 'org', id: 'org-1' } satisfies Owner;
  const installation = {
    botToken: 'xoxb-new-token',
    botUserId: 'U_NEW_BOT',
    teamName: 'Kilo Team',
  } satisfies SlackInstallation;

  function organizationIntegration(
    platformInstallationId: string | null,
    platformAccountId: string | null = platformInstallationId
  ) {
    return buildSlackIntegration({
      owned_by_user_id: null,
      owned_by_organization_id: organizationOwner.id,
      platform_installation_id: platformInstallationId,
      platform_account_id: platformAccountId,
    });
  }

  beforeEach(() => {
    mockLimit.mockReset();
    // A workspace lookup the test does not script finds no row.
    mockLimit.mockResolvedValue([]);
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateReturning.mockResolvedValue([buildSlackIntegration()]);
    mockWriteSlackCredential.mockReset();
    mockWriteSlackCredential.mockResolvedValue({ id: 'credential-1' });
    mockGetDefaultAllowedModel.mockReset();
    mockGetDefaultAllowedModel.mockResolvedValue(DEFAULT_BOT_MODEL);
  });

  it('uses the supplied default model without resolving organization policy again', async () => {
    mockLimit.mockResolvedValueOnce([organizationIntegration('T123')]).mockResolvedValueOnce([]);

    await upsertSlackInstallation({
      owner: organizationOwner,
      teamId: 'T123',
      installation,
      defaultModel: 'test/default-model',
    });

    expect(mockGetDefaultAllowedModel).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ model_slug: 'test/default-model' }),
      })
    );
  });

  it('stores no model when the supplied model is null', async () => {
    mockLimit.mockResolvedValueOnce([organizationIntegration('T123')]).mockResolvedValueOnce([]);

    await upsertSlackInstallation({
      owner: organizationOwner,
      teamId: 'T123',
      installation,
      defaultModel: null,
    });

    expect(mockGetDefaultAllowedModel).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ model_slug: expect.anything() }),
      })
    );
  });

  it('refuses to move an organization connection without caller authorization', async () => {
    mockLimit.mockResolvedValueOnce([organizationIntegration('T_OLD')]).mockResolvedValueOnce([]);

    await expect(
      upsertSlackInstallation({ owner: organizationOwner, teamId: 'T_NEW', installation })
    ).rejects.toThrow(SlackWorkspaceRebindNotAllowedError);

    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('moves an organization connection when the caller authorized the change', async () => {
    mockLimit.mockResolvedValueOnce([organizationIntegration('T_OLD')]).mockResolvedValueOnce([]);

    await upsertSlackInstallation({
      owner: organizationOwner,
      teamId: 'T_NEW',
      installation,
      allowWorkspaceRebind: true,
    });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ platform_installation_id: 'T_NEW' })
    );
  });

  it('refreshes an organization connection bound to the same workspace', async () => {
    mockLimit.mockResolvedValueOnce([organizationIntegration('T123')]).mockResolvedValueOnce([]);

    await upsertSlackInstallation({ owner: organizationOwner, teamId: 'T123', installation });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ platform_installation_id: 'T123' })
    );
  });

  it('binds an organization row that has no workspace yet', async () => {
    mockLimit
      .mockResolvedValueOnce([organizationIntegration(null, null)])
      .mockResolvedValueOnce([]);

    await upsertSlackInstallation({ owner: organizationOwner, teamId: 'T123', installation });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ platform_installation_id: 'T123' })
    );
  });

  it('refuses a legacy organization row bound only by its account id', async () => {
    mockLimit
      .mockResolvedValueOnce([organizationIntegration(null, 'T_OLD')])
      .mockResolvedValueOnce([]);

    await expect(
      upsertSlackInstallation({ owner: organizationOwner, teamId: 'T_NEW', installation })
    ).rejects.toThrow(SlackWorkspaceRebindNotAllowedError);

    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('keeps personal workspace changes allowed', async () => {
    mockLimit
      .mockResolvedValueOnce([buildSlackIntegration({ platform_installation_id: 'T_OLD' })])
      .mockResolvedValueOnce([]);

    await upsertSlackInstallation({ owner, teamId: 'T_NEW', installation });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ platform_installation_id: 'T_NEW' })
    );
  });
});
