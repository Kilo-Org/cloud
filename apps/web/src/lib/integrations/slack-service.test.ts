process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

const mockLimit = jest.fn();
const mockDeleteWhere = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateReturning = jest.fn();
const mockAuthRevoke = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: {
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
  },
}));

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn(() => ({
    auth: {
      revoke: mockAuthRevoke,
    },
  })),
}));

import type { Owner } from '@/lib/integrations/core/types';
import {
  getSlackMissingScopeErrorInfo,
  isSlackMissingScopeError,
  markSlackInstallationRequiresReinstall,
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
    ...overrides,
  };
}

function buildSlackMissingScopeError() {
  return Object.assign(new Error('An API error occurred: missing_scope'), {
    code: 'slack_webapi_platform_error',
    data: {
      ok: false,
      error: 'missing_scope',
      needed: 'assistant:write,views:write',
      provided: 'chat:write',
    },
  });
}

describe('slack-service uninstallApp', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockDeleteWhere.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockAuthRevoke.mockReset();
    mockAuthRevoke.mockResolvedValue({ ok: true });
    mockDeleteWhere.mockResolvedValue(undefined);
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
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
});

describe('slack-service reinstall metadata', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockDeleteWhere.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockAuthRevoke.mockReset();
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  });

  it('detects Slack missing_scope platform errors', () => {
    const error = buildSlackMissingScopeError();

    expect(isSlackMissingScopeError(error)).toBe(true);
    expect(getSlackMissingScopeErrorInfo(error)).toEqual({
      error: 'missing_scope',
      missingScopes: ['assistant:write', 'views:write'],
      providedScopes: ['chat:write'],
    });
    expect(
      getSlackMissingScopeErrorInfo(
        Object.assign(new Error('An API error occurred: missing_scope'), {
          code: 'slack_webapi_platform_error',
          data: { ok: false, error: 'missing_scope' },
        })
      )
    ).toEqual({
      error: 'missing_scope',
      missingScopes: [],
      providedScopes: [],
    });
    expect(isSlackMissingScopeError(new Error('different error'))).toBe(false);
  });

  it('marks an installation as requiring reinstall for missing scopes', async () => {
    mockLimit.mockResolvedValue([
      buildSlackIntegration({
        metadata: {
          access_token: 'xoxb-token',
          model_slug: 'anthropic/claude-sonnet-4.5',
          missing_scopes: ['assistant:write'],
        },
      }),
    ]);

    await expect(
      markSlackInstallationRequiresReinstall('T123', buildSlackMissingScopeError())
    ).resolves.toMatchObject({
      error: 'missing_scope',
      integrationId: 'integration-1',
      missingScopes: ['assistant:write', 'views:write'],
      providedScopes: ['chat:write'],
    });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          access_token: 'xoxb-token',
          model_slug: 'anthropic/claude-sonnet-4.5',
          requires_reinstall: true,
          missing_scopes: ['assistant:write', 'views:write'],
          last_scope_error_code: 'missing_scope',
        }),
      })
    );
  });

  it('does not mark reinstall for non-missing-scope errors', async () => {
    await expect(
      markSlackInstallationRequiresReinstall('T123', new Error('ratelimited'))
    ).resolves.toBe(null);

    expect(mockLimit).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('preserves the selected model and clears reinstall flags during reinstall', async () => {
    const updatedIntegration = buildSlackIntegration({
      metadata: {
        access_token: 'new-token',
        bot_user_id: 'BNEW',
        model_slug: 'anthropic/claude-sonnet-4.5',
      },
    });
    mockLimit.mockResolvedValue([
      buildSlackIntegration({
        metadata: {
          access_token: 'old-token',
          bot_user_id: 'BOLD',
          model_slug: 'anthropic/claude-sonnet-4.5',
          requires_reinstall: true,
          missing_scopes: ['assistant:write'],
          last_scope_error_at: '2026-04-28T12:00:00.000Z',
          last_scope_error_code: 'missing_scope',
        },
      }),
    ]);
    mockUpdateReturning.mockResolvedValue([updatedIntegration]);

    await expect(
      upsertSlackInstallation({
        owner,
        teamId: 'T123',
        installation: {
          botToken: 'new-token',
          botUserId: 'BNEW',
          teamName: 'Kilo Test',
        },
      })
    ).resolves.toBe(updatedIntegration);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        platform_installation_id: 'T123',
        platform_account_id: 'T123',
        platform_account_login: 'Kilo Test',
        integration_status: 'active',
        metadata: {
          access_token: 'new-token',
          bot_user_id: 'BNEW',
          model_slug: 'anthropic/claude-sonnet-4.5',
        },
      })
    );
  });
});
