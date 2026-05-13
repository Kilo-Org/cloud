import { afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { PLATFORM, INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import {
  getDoltHubOAuthUrl,
  exchangeDoltHubOAuthCode,
  refreshDoltHubAccessToken,
  getInstallation,
  upsertDoltHubInstallation,
  uninstall,
  getValidDoltHubToken,
  DOLTHUB_REDIRECT_URI,
  DOLTHUB_SCOPES,
} from '@/lib/integrations/dolthub-service';
import { DOLTHUB_APP_DEV_CLIENT_ID } from '@/lib/config.server';

function setNodeEnv(value: string) {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('dolthub-service', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  let user: User;

  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'dolthub-test@example.com',
      google_user_name: 'DoltHub Test',
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setNodeEnv(originalNodeEnv);
    await db
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.DOLTHUB),
          eq(platform_integrations.owned_by_user_id, user.id)
        )
      );
  });

  describe('getDoltHubOAuthUrl', () => {
    test('includes the required OAuth parameters', () => {
      const url = getDoltHubOAuthUrl('test-state-123');
      expect(url).toMatch(/^https:\/\/www\.dolthub\.com\/oauth\/authorize/);
      expect(url).toContain(`client_id=${encodeURIComponent(DOLTHUB_APP_DEV_CLIENT_ID)}`);
      expect(url).toContain('response_type=code');
      expect(url).toContain(`redirect_uri=${encodeURIComponent(DOLTHUB_REDIRECT_URI)}`);
      expect(url).toContain(`scope=${encodeURIComponent(DOLTHUB_SCOPES.join(','))}`);
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
        'DoltHub token exchange returned invalid payload'
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
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'token' },
      });

      const result = await getInstallation({ type: 'user', id: user.id });
      expect(result).not.toBeNull();
      expect(result?.platform_account_login).toBe('testuser');
    });

    test('returns null when not found', async () => {
      const result = await getInstallation({ type: 'user', id: user.id });
      expect(result).toBeNull();
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(getInstallation({ type: 'user', id: user.id })).rejects.toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });

  describe('upsertDoltHubInstallation', () => {
    test('creates a new installation when none exists', async () => {
      const result = await upsertDoltHubInstallation({
        owner: { type: 'user', id: user.id },
        tokens: {
          accessToken: 'token-new',
          refreshToken: 'refresh-new',
          expiresIn: 3600,
          scope: 'api_read_write',
        },
      });

      expect(result.platform).toBe(PLATFORM.DOLTHUB);
      expect(result.integration_status).toBe(INTEGRATION_STATUS.ACTIVE);
      expect(result.platform_account_login).toBeNull();
      expect(result.platform_installation_id).toBe(`dolthub-user-${user.id}`);

      const [row] = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DOLTHUB),
            eq(platform_integrations.owned_by_user_id, user.id)
          )
        );
      const meta = row.metadata as { access_token: string };
      expect(meta.access_token).toBe('token-new');
    });

    test('updates an existing installation', async () => {
      await upsertDoltHubInstallation({
        owner: { type: 'user', id: user.id },
        tokens: {
          accessToken: 'token-old',
          refreshToken: 'refresh-old',
          expiresIn: 3600,
          scope: 'api_read_write',
        },
      });

      await upsertDoltHubInstallation({
        owner: { type: 'user', id: user.id },
        tokens: {
          accessToken: 'token-updated',
          refreshToken: 'refresh-updated',
          expiresIn: 7200,
          scope: 'api_read_write',
        },
      });

      const [row] = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DOLTHUB),
            eq(platform_integrations.owned_by_user_id, user.id)
          )
        );
      const meta = row.metadata as { access_token: string; refresh_token: string };
      expect(meta.access_token).toBe('token-updated');
      expect(meta.refresh_token).toBe('refresh-updated');
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(
        upsertDoltHubInstallation({
          owner: { type: 'user', id: user.id },
          tokens: {
            accessToken: 't',
            refreshToken: null,
            expiresIn: null,
            scope: null,
          },
        })
      ).rejects.toThrow('DoltHub integration is dev-only and not available in production');
    });

    test('concurrent upserts for the same owner produce a single row', async () => {
      const tokens = (suffix: string) => ({
        accessToken: `token-${suffix}`,
        refreshToken: `refresh-${suffix}`,
        expiresIn: 3600,
        scope: 'api_read_write',
      });

      await Promise.all([
        upsertDoltHubInstallation({ owner: { type: 'user', id: user.id }, tokens: tokens('a') }),
        upsertDoltHubInstallation({ owner: { type: 'user', id: user.id }, tokens: tokens('b') }),
        upsertDoltHubInstallation({ owner: { type: 'user', id: user.id }, tokens: tokens('c') }),
      ]);

      const rows = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DOLTHUB),
            eq(platform_integrations.owned_by_user_id, user.id)
          )
        );
      expect(rows).toHaveLength(1);
    });
  });

  describe('uninstall', () => {
    test('deletes the installation when found', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'token' },
      });

      const result = await uninstall({ type: 'user', id: user.id });
      expect(result.success).toBe(true);

      const rows = await db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DOLTHUB),
            eq(platform_integrations.owned_by_user_id, user.id)
          )
        );
      expect(rows).toHaveLength(0);
    });

    test('succeeds when no installation exists', async () => {
      const result = await uninstall({ type: 'user', id: user.id });
      expect(result.success).toBe(true);
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      await expect(uninstall({ type: 'user', id: user.id })).rejects.toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });

  describe('getValidDoltHubToken', () => {
    test('returns access token when not expired', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'current-token',
            refresh_token: 'refresh-token',
            expires_at: Date.now() + 3600 * 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      const token = await getValidDoltHubToken(integration);
      expect(token).toBe('current-token');
    });

    test('refreshes and persists new token when expired', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'expired-token',
            refresh_token: 'old-refresh',
            expires_at: Date.now() - 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
          scope: 'api_read_write',
        }),
      });

      const token = await getValidDoltHubToken(integration);
      expect(token).toBe('refreshed-access');

      const [row] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      const meta = row.metadata as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
      };
      expect(meta.access_token).toBe('refreshed-access');
      expect(meta.refresh_token).toBe('refreshed-refresh');
      expect(meta.expires_at).toBeGreaterThan(Date.now());
    });

    test('preserves existing refresh_token and scope when refresh response omits them', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'expired-token',
            refresh_token: 'old-refresh',
            expires_at: Date.now() - 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      // DoltHub may return only an access_token on refresh; per RFC 6749 the
      // previous refresh_token and scope remain valid.
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-access',
          expires_in: 3600,
        }),
      });

      const token = await getValidDoltHubToken(integration);
      expect(token).toBe('refreshed-access');

      const [row] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      const meta = row.metadata as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
        scope: string;
      };
      expect(meta.access_token).toBe('refreshed-access');
      expect(meta.refresh_token).toBe('old-refresh');
      expect(meta.scope).toBe('api_read_write');
      expect(meta.expires_at).toBeGreaterThan(Date.now());
    });

    test('returns null when expired and no refresh token exists', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            access_token: 'expired-token',
            refresh_token: null,
            expires_at: Date.now() - 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      const token = await getValidDoltHubToken(integration);
      expect(token).toBeNull();
    });

    test('returns null when access token is missing', async () => {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: {
            refresh_token: 'refresh-token',
            expires_at: Date.now() + 3600 * 1000,
            scope: 'api_read_write',
          },
        })
        .returning();

      const token = await getValidDoltHubToken(integration);
      expect(token).toBeNull();
    });

    test('throws in production', async () => {
      setNodeEnv('production');
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          owned_by_organization_id: null,
          platform: PLATFORM.DOLTHUB,
          integration_type: 'oauth',
          platform_account_login: 'testuser',
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata: { access_token: 'token' },
        })
        .returning();

      await expect(getValidDoltHubToken(integration)).rejects.toThrow(
        'DoltHub integration is dev-only and not available in production'
      );
    });
  });
});
