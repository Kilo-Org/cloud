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
const mockFor = jest.fn();
jest.mock('@/lib/drizzle', () => {
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: mockLimit, for: mockFor })),
      })),
    })),
    delete: jest.fn(() => ({ where: mockDeleteWhere })),
    update: jest.fn(() => ({ set: mockUpdateSet })),
    insert: jest.fn(() => ({ values: mockInsertValues })),
    execute: jest.fn(async () => ({ rows: [] })),
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation((callback: (tx: typeof db) => unknown) => callback(db));
  return { db };
});

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn(() => ({
    auth: {
      revoke: mockAuthRevoke,
      test: mockAuthTest,
    },
  })),
}));

const mockWriteSlackCredential = jest.fn();
jest.mock('@/lib/integrations/platforms/slack/credential-store', () => ({
  writeSlackCredential: (...args: unknown[]) => mockWriteSlackCredential(...args),
  getSlackCredentialByIntegrationId: jest.fn(async () => null),
  decryptSlackBotToken: jest.fn(() => 'xoxb-token'),
}));

jest.mock('@/lib/integrations/provider-installation-reservations', () => ({
  expireSlackReservations: jest.fn(async () => undefined),
  getRecoverableSlackReservation: jest.fn(async () => null),
  lockSlackReservation: jest.fn(),
  activateSlackReservation: jest.fn(),
  adoptLegacySlackReservation: jest.fn(async () => undefined),
}));

const mockCaptureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
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

function mockUninstallRows(integration: ReturnType<typeof buildSlackIntegration>) {
  mockLimit.mockResolvedValue([integration]);
  mockFor
    .mockResolvedValueOnce([integration])
    .mockResolvedValueOnce([integration])
    .mockResolvedValueOnce([integration])
    .mockResolvedValueOnce([integration])
    .mockResolvedValueOnce([integration])
    .mockResolvedValueOnce([integration]);
}

describe('slack-service uninstallApp', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockDeleteWhere.mockReset();
    mockFor.mockReset();
    mockAuthRevoke.mockReset();
    mockAuthRevoke.mockResolvedValue({ ok: true });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateReturning.mockResolvedValue([buildSlackIntegration()]);
    mockDeleteWhere.mockResolvedValue(undefined);
    mockFor.mockImplementation(() => mockLimit());
  });

  it('deletes Chat SDK Slack state before removing the platform integration row', async () => {
    mockUninstallRows(buildSlackIntegration());
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {});

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).resolves.toEqual({
      success: true,
      cleanupPending: false,
    });

    expect(deleteChatSdkInstallation).toHaveBeenCalledWith('T123');
    expect(deleteChatSdkIdentityCache).toHaveBeenCalledWith('T123');
    expect(mockDeleteWhere).toHaveBeenCalledTimes(3);
    expect(deleteChatSdkInstallation.mock.invocationCallOrder[0]).toBeLessThan(
      deleteChatSdkIdentityCache.mock.invocationCallOrder[0]
    );
  });

  it('finishes local uninstall when Chat SDK installation cleanup fails', async () => {
    mockUninstallRows(buildSlackIntegration());
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {
      throw new Error('redis unavailable');
    });

    await expect(uninstallApp(owner, { deleteChatSdkInstallation })).resolves.toEqual({
      success: true,
      cleanupPending: true,
    });

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it('finishes local uninstall when Chat SDK identity cleanup fails', async () => {
    mockUninstallRows(buildSlackIntegration());
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {
      throw new Error('redis unavailable');
    });

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).resolves.toEqual({ success: true, cleanupPending: true });

    expect(deleteChatSdkInstallation).toHaveBeenCalledWith('T123');
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it('falls back to the platform account ID for older rows without an installation ID', async () => {
    mockUninstallRows(
      buildSlackIntegration({ platform_installation_id: null, platform_account_id: 'T456' })
    );
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});

    await uninstallApp(owner, { deleteChatSdkInstallation });

    expect(deleteChatSdkInstallation).toHaveBeenCalledWith('T456');
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it('disconnects suspended integrations without deleting shared Slack installation state', async () => {
    mockUninstallRows(
      buildSlackIntegration({
        integration_status: 'suspended',
        platform_installation_id: null,
        platform_account_id: 'T456',
      })
    );
    const deleteChatSdkInstallation = jest.fn(async (_teamId: string): Promise<void> => {});
    const deleteChatSdkIdentityCache = jest.fn(async (_teamId: string): Promise<void> => {});

    await expect(
      uninstallApp(owner, { deleteChatSdkInstallation, deleteChatSdkIdentityCache })
    ).resolves.toEqual({ success: true, cleanupPending: false });

    expect(mockAuthRevoke).not.toHaveBeenCalled();
    expect(deleteChatSdkInstallation).not.toHaveBeenCalled();
    expect(deleteChatSdkIdentityCache).not.toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalledTimes(2);
  });
});

describe('slack-service deleteInstallationByTeamId', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockFor.mockReset();
    mockDeleteWhere.mockReset();
    mockDeleteWhere.mockResolvedValue(undefined);
  });

  it('deletes the platform integration and Chat SDK state for a Slack team', async () => {
    mockUninstallRows(buildSlackIntegration());

    await expect(deleteInstallationByTeamId('T123')).resolves.toEqual({
      success: true,
      deleted: true,
    });

    expect(mockDeleteWhere).toHaveBeenCalledTimes(2);
  });
});

describe('slack-service testConnection', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockAuthTest.mockReset();
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

  it('returns failure when the access token is missing from metadata', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration({ metadata: {} })]);

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
    mockWriteSlackCredential.mockReset();
    mockWriteSlackCredential.mockResolvedValue({ id: 'credential-1' });
    mockCaptureException.mockReset();
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

  it('dual-writes the bot token into the encrypted credential store on a new install', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const installation = {
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockWriteSlackCredential).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      slackTeamId: 'T123',
      owner,
      botToken: 'xoxb-new-token',
      botUserId: 'U_NEW_BOT',
    });
  });

  it('dual-writes the bot token when refreshing an existing install', async () => {
    mockLimit.mockResolvedValue([buildSlackIntegration()]);

    const installation = {
      botToken: 'xoxb-rotated-token',
      botUserId: 'U_NEW_BOT',
      teamName: 'Kilo Team',
    } satisfies SlackInstallation;

    await upsertSlackInstallation({ owner, teamId: 'T123', installation });

    expect(mockWriteSlackCredential).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: 'xoxb-rotated-token', slackTeamId: 'T123' })
    );
  });

  it('fails the install when encrypted credential persistence fails', async () => {
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

    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
