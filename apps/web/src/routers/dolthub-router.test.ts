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
        integration_status: INTEGRATION_STATUS.ACTIVE,
        scopes: ['api_read_write'],
        metadata: { access_token: 'token' },
        installed_at: new Date().toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.dolthub.getInstallation();
      expect(result.installed).toBe(true);
      expect(result.installation).toMatchObject({
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
});
