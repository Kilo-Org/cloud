// Mock config.server so dolthub-service imports don't fail on missing env vars
import type * as ConfigServerModule from '@/lib/config.server';
jest.mock('@/lib/config.server', () => {
  const actual = jest.requireActual<typeof ConfigServerModule>('@/lib/config.server');
  return {
    ...actual,
    DOLTHUB_APP_DEV_CLIENT_ID: 'dolthub-client-id-test',
    DOLTHUB_APP_DEV_CLIENT_SECRET: 'dolthub-client-secret-test',
  };
});

import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { PLATFORM, INTEGRATION_STATUS } from '@/lib/integrations/core/constants';

function setNodeEnv(value: string) {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('dolthubRouter', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  let user: User;

  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'dolthub-router-test@example.com',
      google_user_name: 'DoltHub Router Test',
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

  describe('getInstallation', () => {
    test('returns installed: false in production', async () => {
      setNodeEnv('production');
      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallation();
      expect(result).toEqual({ installed: false, installation: null });
    });

    test('returns the persisted row when present in dev', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        scopes: ['api_read_write'],
        metadata: { access_token: 'token' },
        installed_at: new Date().toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallation();
      expect(result.installed).toBe(true);
      expect(result.installation).toMatchObject({
        username: 'testuser',
        status: 'active',
        scopes: ['api_read_write'],
      });
      expect(result.installation?.installedAt).toBeTruthy();
    });

    test('returns installed: false when no integration exists in dev', async () => {
      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallation();
      expect(result).toEqual({ installed: false, installation: null });
    });
  });

  describe('disconnect', () => {
    test('throws in production', async () => {
      setNodeEnv('production');
      const caller = await createCallerForUser(user.id);
      await expect(caller.dolthub.disconnect()).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    test('removes the integration in dev', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { access_token: 'token' },
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.disconnect();
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
  });

  describe('verifyToken', () => {
    test('throws in production', async () => {
      setNodeEnv('production');
      const caller = await createCallerForUser(user.id);
      await expect(caller.dolthub.verifyToken()).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    test('makes the expected HTTP call with Authorization: Bearer ...', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: {
          access_token: 'test-access-token',
          refresh_token: 'refresh-token',
          expires_at: Date.now() + 3600 * 1000,
          scope: 'api_read_write',
        },
      });

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ '1': 1 }],
      });
      globalThis.fetch = mockFetch;

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.verifyToken();
      expect(result.ok).toBe(true);
      expect(result.sample).toEqual({ '1': 1 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://www.dolthub.com/api/v1alpha1/dolthub/profile?q=select+1');
      expect(init?.headers?.Authorization).toBe('Bearer test-access-token');
    });

    test('rejects when the smoke test fails', async () => {
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: PLATFORM.DOLTHUB,
        integration_type: 'oauth',
        platform_account_login: 'testuser',
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: {
          access_token: 'bad-token',
          refresh_token: 'refresh-token',
          expires_at: Date.now() + 3600 * 1000,
          scope: 'api_read_write',
        },
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const caller = await createCallerForUser(user.id);
      const rejection = caller.dolthub.verifyToken();
      await expect(rejection).rejects.toBeInstanceOf(TRPCError);
      await expect(rejection).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    test('rejects when no integration exists', async () => {
      const caller = await createCallerForUser(user.id);
      await expect(caller.dolthub.verifyToken()).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
