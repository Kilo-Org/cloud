process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

const mockLimit = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateReturning = jest.fn();
const mockDeleteWhere = jest.fn();
const mockInsertValues = jest.fn();
const mockInsertReturning = jest.fn();
const mockAuthRevoke = jest.fn();
const mockAuthTest = jest.fn();
const mockUpsertWorkspaceInstallation = jest.fn();
const mockDeleteWorkspaceInstallation = jest.fn();
const mockDeleteWorkspaceInstallationIfUnreferenced = jest.fn();
const mockGetSlackBotToken = jest.fn();
const mockTransaction = jest.fn();

jest.mock('@/lib/drizzle', () => {
  const client = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
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
    // Hands the callback the same client, so statements issued inside a
    // transaction land on the same assertions as statements issued outside one.
    transaction: (...args: unknown[]) => mockTransaction(...args),
  };

  return { db: client };
});

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn(() => ({
    auth: {
      revoke: mockAuthRevoke,
      test: mockAuthTest,
    },
  })),
}));

// The factory runs while `slack-service` is being imported, which happens before
// the `const` declarations above are initialized, so each export forwards lazily
// instead of capturing the mock function directly.
jest.mock('@/lib/integrations/slack-workspace-installation', () => ({
  upsertSlackWorkspaceInstallation: (...args: unknown[]) =>
    mockUpsertWorkspaceInstallation(...args),
  deleteSlackWorkspaceInstallation: (...args: unknown[]) =>
    mockDeleteWorkspaceInstallation(...args),
  deleteSlackWorkspaceInstallationIfUnreferenced: (...args: unknown[]) =>
    mockDeleteWorkspaceInstallationIfUnreferenced(...args),
  getSlackBotToken: (...args: unknown[]) => mockGetSlackBotToken(...args),
}));

import type { Owner } from '@/lib/integrations/core/types';
import type { SlackInstallation } from '@chat-adapter/slack';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import {
  deleteInstallationByTeamId,
  getMissingSlackScopes,
  SlackWorkspaceAlreadyConnectedError,
  SLACK_SCOPES,
  testConnection,
  uninstallApp,
  upsertSlackInstallation,
} from './slack-service';

const owner = { type: 'user', id: 'user-1' } satisfies Owner;

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

function resetTransactionMock() {
  const { db } = jest.requireMock('@/lib/drizzle') as { db: unknown };
  mockTransaction.mockReset();
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
}

function resetWorkspaceInstallationMocks() {
  mockUpsertWorkspaceInstallation.mockReset();
  mockDeleteWorkspaceInstallation.mockReset();
  mockDeleteWorkspaceInstallationIfUnreferenced.mockReset();
  mockGetSlackBotToken.mockReset();
  mockUpsertWorkspaceInstallation.mockResolvedValue({ team_id: 'T123' });
  mockDeleteWorkspaceInstallation.mockResolvedValue(undefined);
  mockDeleteWorkspaceInstallationIfUnreferenced.mockResolvedValue(undefined);
  mockGetSlackBotToken.mockResolvedValue('xoxb-token');
}

describe('slack-service uninstallApp', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockDeleteWhere.mockReset();
    mockAuthRevoke.mockReset();
    mockAuthRevoke.mockResolvedValue({ ok: true });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateReturning.mockResolvedValue([buildSlackIntegration()]);
    mockDeleteWhere.mockResolvedValue(undefined);
    resetWorkspaceInstallationMocks();
    resetTransactionMock();
  });

  // Whether the record is actually removed depends on the reference check inside
  // deleteSlackWorkspaceInstallationIfUnreferenced, which is covered against a real
  // database in slack-workspace-installation.test.ts.
  it('asks for the workspace installation to be removed', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);

    await uninstallApp(owner);

    expect(mockDeleteWorkspaceInstallationIfUnreferenced).toHaveBeenCalledWith('T123');
  });

  it('revokes the token resolved from the workspace installation', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration({ metadata: {} })]);
    mockGetSlackBotToken.mockResolvedValue('xoxb-workspace-token');

    await uninstallApp(owner);

    expect(mockAuthRevoke).toHaveBeenCalledTimes(1);
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
    expect(mockDeleteWorkspaceInstallationIfUnreferenced).not.toHaveBeenCalled();
  });
});

describe('slack-service deleteInstallationByTeamId', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockDeleteWhere.mockReset();
    mockDeleteWhere.mockResolvedValue(undefined);
    resetWorkspaceInstallationMocks();
    resetTransactionMock();
  });

  it('deletes the platform integration and Chat SDK state for a Slack team', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);

    await expect(deleteInstallationByTeamId('T123')).resolves.toEqual({
      success: true,
      deleted: true,
    });

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockDeleteWorkspaceInstallationIfUnreferenced).toHaveBeenCalledWith('T123');
  });

  it('still clears workspace state when the platform integration is already gone', async () => {
    mockLimit.mockResolvedValue([]);

    await expect(deleteInstallationByTeamId('T123')).resolves.toEqual({
      success: true,
      deleted: false,
    });

    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(mockDeleteWorkspaceInstallation).toHaveBeenCalledWith('T123');
  });
});

describe('slack-service testConnection', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockAuthTest.mockReset();
    resetWorkspaceInstallationMocks();
    resetTransactionMock();
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

  it('returns failure when no bot token can be resolved', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration({ metadata: {} })]);
    mockGetSlackBotToken.mockResolvedValue(undefined);

    await expect(testConnection(owner)).resolves.toEqual({
      success: false,
      error: 'No access token found',
    });
    expect(mockAuthTest).not.toHaveBeenCalled();
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
    resetWorkspaceInstallationMocks();
    resetTransactionMock();
  });

  it('writes the bot token to the workspace installation store', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({
      owner,
      teamId: 'T123',
      installation,
      installedByUserId: 'user-1',
    });

    expect(mockUpsertWorkspaceInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'T123',
        teamName: 'Kilo Team',
        botToken: 'xoxb-new-token',
        botUserId: 'U_NEW_BOT',
        scopes: SLACK_SCOPES,
        installedByUserId: 'user-1',
      })
    );
  });

  it('writes the workspace installation before the platform integration row', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockUpsertWorkspaceInstallation.mock.invocationCallOrder[0]).toBeLessThan(
      mockInsertValues.mock.invocationCallOrder[0]
    );
  });

  it('removes the previous workspace installation when an owner switches workspaces', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({ platform_installation_id: 'T_OLD', platform_account_id: 'T_OLD' }),
    ]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T_NEW', installation });

    expect(mockUpsertWorkspaceInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'T_NEW' })
    );
    expect(mockDeleteWorkspaceInstallationIfUnreferenced).toHaveBeenCalledWith('T_OLD');
  });

  it('keeps the previous workspace installation when the workspace is unchanged', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({ platform_installation_id: 'T123', platform_account_id: 'T123' }),
    ]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockDeleteWorkspaceInstallationIfUnreferenced).not.toHaveBeenCalled();
  });

  it('writes the workspace installation inside the integration transaction', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockUpsertWorkspaceInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ executor: expect.anything() })
    );
  });

  // The transaction rolls the workspace record back, so there is no compensating
  // delete to issue and no risk of one masking the original error.
  it('propagates the original error without a compensating delete when the write fails', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockInsertReturning.mockRejectedValue(new Error('insert exploded'));

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await expect(upsertSlackInstallation({ owner, teamId: 'T123', installation })).rejects.toThrow(
      'insert exploded'
    );

    expect(mockDeleteWorkspaceInstallationIfUnreferenced).not.toHaveBeenCalled();
    expect(mockDeleteWorkspaceInstallation).not.toHaveBeenCalled();
  });

  it('still translates a workspace unique violation when the write fails', async () => {
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
      SlackWorkspaceAlreadyConnectedError
    );
  });

  it('clears an earlier suspension when refreshing an existing installation', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({
        integration_status: 'suspended',
        suspended_by: 'duplicate_slack_workspace_migration',
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
        integration_status: 'active',
        suspended_at: null,
        suspended_by: null,
      })
    );
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
        metadata: expect.objectContaining({
          access_token: 'xoxb-new-token',
          bot_user_id: 'U_NEW_BOT',
          incoming_webhook: { channel: '#general', channelId: 'C123', url: 'https://example.com' },
          model_slug: 'anthropic/claude-sonnet-4.5',
        }),
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
          access_token: 'xoxb-new-token',
          bot_user_id: 'U_NEW_BOT',
          model_slug: DEFAULT_BOT_MODEL,
        }),
      })
    );
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
});
