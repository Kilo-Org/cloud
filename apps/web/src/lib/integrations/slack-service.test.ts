process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

const mockLimit = jest.fn();
const mockDeleteWhere = jest.fn();
const mockAuthRevoke = jest.fn();
const mockAuthTest = jest.fn();

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

import type { Owner } from '@/lib/integrations/core/types';
import { testConnection, uninstallApp } from './slack-service';

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

describe('slack-service uninstallApp', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockDeleteWhere.mockReset();
    mockAuthRevoke.mockReset();
    mockAuthRevoke.mockResolvedValue({ ok: true });
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
