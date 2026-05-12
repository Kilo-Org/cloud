import type * as ConfigServerModule from '@/lib/config.server';
jest.mock('@/lib/config.server', () => {
  const actual = jest.requireActual<typeof ConfigServerModule>('@/lib/config.server');
  return {
    ...actual,
    DOLTHUB_APP_DEV_CLIENT_ID: 'dhoci.v1.tdg4bfv15v24adbpc2fqeqddugotg64nd9puisim322d0p452i50',
    DOLTHUB_APP_DEV_CLIENT_SECRET: 'dolthub-client-secret-test',
  };
});

const mockSelectLimit = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateReturning = jest.fn();
const mockDeleteWhere = jest.fn();
const mockInsertValues = jest.fn();
const mockInsertReturning = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: mockSelectLimit,
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
  },
}));

import { describe, test, expect, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  getDoltHubOAuthUrl,
  exchangeDoltHubOAuthCode,
  refreshDoltHubAccessToken,
  getInstallation,
  upsertDoltHubInstallation,
  uninstall,
  getValidDoltHubToken,
  DOLTHUB_REDIRECT_URI,
} from '@/lib/integrations/dolthub-service';

function setNodeEnv(value: string) {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value,
    configurable: true,
    writable: true,
  });
}

function buildIntegration(overrides: Record<string, unknown> = {}): PlatformIntegration {
  return {
    id: 'integration-1',
    platform: 'dolthub',
    integration_type: 'oauth',
    integration_status: 'active',
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
    platform_account_login: 'testuser',
    metadata: {
      access_token: 'access-token-123',
      refresh_token: 'refresh-token-456',
      expires_at: Date.now() + 3600 * 1000,
      scope: 'api_read_write',
    },
    created_at: new Date().toISOString(),
    created_by_user_id: null,
    github_app_type: null,
    installed_at: new Date().toISOString(),
    kilo_requester_user_id: null,
    permissions: null,
    platform_account_id: null,
    platform_installation_id: null,
    platform_requester_account_id: null,
    repositories: null,
    repositories_synced_at: null,
    repository_access: null,
    scopes: null,
    suspended_at: null,
    suspended_by: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  } as PlatformIntegration;
}

const owner = { type: 'user' as const, id: 'user-1' };

describe('dolthub-service', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    setNodeEnv(originalNodeEnv);
    mockSelectLimit.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
    mockDeleteWhere.mockReset();
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();

    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
  });

  describe('getDoltHubOAuthUrl', () => {
    test('includes the exact registered client ID and redirect URI', () => {
      const url = getDoltHubOAuthUrl('test-state-123');
      expect(url).toMatch(/^https:\/\/www\.dolthub\.com\/oauth\/authorize/);
      expect(url).toContain(
        'client_id=dhoci.v1.tdg4bfv15v24adbpc2fqeqddugotg64nd9puisim322d0p452i50'
      );
      expect(url).toContain(`redirect_uri=${encodeURIComponent(DOLTHUB_REDIRECT_URI)}`);
      expect(url).toContain('scope=api_read_write');
      expect(url).toContain('state=test-state-123');
    });

    test('throws in production', () => {
      setNodeEnv('production');
      expect(() => getDoltHubOAuthUrl('state')).toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });

  describe('exchangeDoltHubOAuthCode', () => {
    test('successfully exchanges code for tokens', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'access-token-123',
          refresh_token: 'refresh-token-456',
          expires_in: 3600,
          scope: 'api_read_write',
        }),
      });
      globalThis.fetch = mockFetch;

      const result = await exchangeDoltHubOAuthCode('auth-code-xyz');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://www.dolthub.com/api/oauth/access_token');
      expect(init?.method).toBe('POST');
      expect(init?.headers?.Authorization).toContain('Basic ');

      expect(result.accessToken).toBe('access-token-123');
      expect(result.refreshToken).toBe('refresh-token-456');
      expect(result.expiresIn).toBe(3600);
      expect(result.scope).toBe('api_read_write');
    });

    test('throws when token exchange fails', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      });

      await expect(exchangeDoltHubOAuthCode('bad-code')).rejects.toThrow(
        'DoltHub token exchange failed: 400 Bad Request'
      );
    });

    test('throws when response lacks access_token', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ refresh_token: 'only-refresh' }),
      });

      await expect(exchangeDoltHubOAuthCode('incomplete')).rejects.toThrow(
        'DoltHub token exchange returned no access_token'
      );
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(exchangeDoltHubOAuthCode('code')).rejects.toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });

  describe('refreshDoltHubAccessToken', () => {
    test('successfully refreshes and returns new tokens', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 7200,
          scope: 'api_read_write',
        }),
      });
      globalThis.fetch = mockFetch;

      const result = await refreshDoltHubAccessToken('old-refresh-token');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://www.dolthub.com/api/oauth/access_token');
      const body = init?.body as string;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=old-refresh-token');

      expect(result.accessToken).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
      expect(result.expiresIn).toBe(7200);
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(refreshDoltHubAccessToken('token')).rejects.toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });

  describe('getInstallation', () => {
    test('returns an integration when found', async () => {
      const integration = buildIntegration();
      mockSelectLimit.mockResolvedValue([integration]);

      const result = await getInstallation(owner);
      expect(result).toEqual(integration);
    });

    test('returns null when not found', async () => {
      mockSelectLimit.mockResolvedValue([]);

      const result = await getInstallation(owner);
      expect(result).toBeNull();
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(getInstallation(owner)).rejects.toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });

  describe('upsertDoltHubInstallation', () => {
    test('creates a new installation when none exists', async () => {
      mockSelectLimit.mockResolvedValue([]);
      const created = buildIntegration({ id: 'new-id', platform_account_login: 'newuser' });
      mockInsertReturning.mockResolvedValue([created]);

      const result = await upsertDoltHubInstallation({
        owner,
        account: { username: 'newuser' },
        tokens: {
          accessToken: 'token-new',
          refreshToken: 'refresh-new',
          expiresIn: 3600,
          scope: 'api_read_write',
        },
      });

      expect(result.platform_account_login).toBe('newuser');
      expect(mockInsertReturning).toHaveBeenCalledTimes(1);
    });

    test('updates an existing installation', async () => {
      const existing = buildIntegration();
      mockSelectLimit.mockResolvedValue([existing]);
      const updated = buildIntegration({ platform_account_login: 'updateduser' });
      mockUpdateReturning.mockResolvedValue([updated]);

      const result = await upsertDoltHubInstallation({
        owner,
        account: { username: 'updateduser' },
        tokens: {
          accessToken: 'token-updated',
          refreshToken: 'refresh-updated',
          expiresIn: 7200,
          scope: 'api_read_write',
        },
      });

      expect(result.platform_account_login).toBe('updateduser');
      expect(mockUpdateReturning).toHaveBeenCalledTimes(1);
      expect(mockInsertReturning).not.toHaveBeenCalled();
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(
        upsertDoltHubInstallation({
          owner,
          account: { username: 'x' },
          tokens: {
            accessToken: 't',
            refreshToken: null,
            expiresIn: null,
            scope: null,
          },
        })
      ).rejects.toThrow('DoltHub integration is dev-only and not available in production');
    });
  });

  describe('uninstall', () => {
    test('deletes the installation when found', async () => {
      mockSelectLimit.mockResolvedValue([buildIntegration()]);
      mockDeleteWhere.mockResolvedValue(undefined);

      const result = await uninstall(owner);
      expect(result.success).toBe(true);
      expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    });

    test('succeeds when no installation exists', async () => {
      mockSelectLimit.mockResolvedValue([]);

      const result = await uninstall(owner);
      expect(result.success).toBe(true);
      expect(mockDeleteWhere).not.toHaveBeenCalled();
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(uninstall(owner)).rejects.toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });

  describe('getValidDoltHubToken', () => {
    test('returns access token when not expired', async () => {
      const integration = buildIntegration({
        metadata: {
          access_token: 'current-token',
          refresh_token: 'refresh-token',
          expires_at: Date.now() + 3600 * 1000,
          scope: 'api_read_write',
        },
      });

      const token = await getValidDoltHubToken(integration);
      expect(token).toBe('current-token');
    });

    test('refreshes and persists new refresh_token when expired', async () => {
      const integration = buildIntegration({
        metadata: {
          access_token: 'expired-token',
          refresh_token: 'old-refresh',
          expires_at: Date.now() - 1000,
          scope: 'api_read_write',
        },
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
          scope: 'api_read_write',
        }),
      });

      mockUpdateReturning.mockResolvedValue([{ ...integration }]);

      const token = await getValidDoltHubToken(integration);
      expect(token).toBe('refreshed-access');

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateSet.mock.calls[0][0];
      expect(updateCall.metadata.access_token).toBe('refreshed-access');
      expect(updateCall.metadata.refresh_token).toBe('refreshed-refresh');
      expect(updateCall.metadata.expires_at).toBeGreaterThan(Date.now());
    });

    test('returns null when expired and no refresh token exists', async () => {
      const integration = buildIntegration({
        metadata: {
          access_token: 'expired-token',
          refresh_token: null,
          expires_at: Date.now() - 1000,
          scope: 'api_read_write',
        },
      });

      const token = await getValidDoltHubToken(integration);
      expect(token).toBeNull();
    });

    test('returns null when access token is missing', async () => {
      const integration = buildIntegration({
        metadata: {
          access_token: undefined,
          refresh_token: 'refresh-token',
          expires_at: Date.now() + 3600 * 1000,
          scope: 'api_read_write',
        },
      });

      const token = await getValidDoltHubToken(integration);
      expect(token).toBeNull();
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(getValidDoltHubToken(buildIntegration())).rejects.toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });
});
