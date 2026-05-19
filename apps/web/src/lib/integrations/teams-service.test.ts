import { afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import {
  TeamsTenantAlreadyConnectedError,
  uninstallApp,
  updateModel,
  upsertTeamsInstallation,
} from './teams-service';

describe('teams-service', () => {
  let user: User;
  let otherUser: User;

  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'teams-upsert@example.com',
      google_user_name: 'Teams Upsert',
    });
    otherUser = await insertTestUser({
      google_user_email: 'teams-upsert-other@example.com',
      google_user_name: 'Teams Other',
    });
  });

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.TEAMS),
          eq(platform_integrations.owned_by_user_id, user.id)
        )
      );
    await db
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.TEAMS),
          eq(platform_integrations.owned_by_user_id, otherUser.id)
        )
      );
  });

  test('creates a user-owned Teams tenant integration', async () => {
    const result = await upsertTeamsInstallation({
      owner: { type: 'user', id: user.id },
      tenantId: 'tenant-a',
      tenantName: 'Acme Teams',
    });

    expect(result.platform).toBe(PLATFORM.TEAMS);
    expect(result.platform_installation_id).toBe('tenant-a');
    expect(result.platform_account_login).toBe('Acme Teams');
    expect(result.integration_status).toBe(INTEGRATION_STATUS.ACTIVE);
    expect(result.metadata).toEqual(
      expect.objectContaining({ bot_enabled: true, model_slug: expect.any(String) })
    );
  });

  test('preserves the selected model on reinstall', async () => {
    await upsertTeamsInstallation({
      owner: { type: 'user', id: user.id },
      tenantId: 'tenant-a',
      tenantName: 'Acme Teams',
    });
    await updateModel({ type: 'user', id: user.id }, 'openai/gpt-test');

    const updated = await upsertTeamsInstallation({
      owner: { type: 'user', id: user.id },
      tenantId: 'tenant-a',
      tenantName: 'Acme Teams Renamed',
    });

    expect(updated.platform_account_login).toBe('Acme Teams Renamed');
    expect(updated.metadata).toEqual(
      expect.objectContaining({ bot_enabled: true, model_slug: 'openai/gpt-test' })
    );
  });

  test('rejects conflicting tenant ownership', async () => {
    await upsertTeamsInstallation({
      owner: { type: 'user', id: user.id },
      tenantId: 'tenant-shared',
      tenantName: 'Shared Teams',
    });

    await expect(
      upsertTeamsInstallation({
        owner: { type: 'user', id: otherUser.id },
        tenantId: 'tenant-shared',
        tenantName: 'Shared Teams',
      })
    ).rejects.toBeInstanceOf(TeamsTenantAlreadyConnectedError);
  });

  test('uninstall deletes Teams identity cache before deleting the row', async () => {
    await upsertTeamsInstallation({
      owner: { type: 'user', id: user.id },
      tenantId: 'tenant-a',
      tenantName: 'Acme Teams',
    });
    const deleteChatSdkIdentityCache = jest.fn(async (_tenantId: string): Promise<void> => {});

    await expect(
      uninstallApp({ type: 'user', id: user.id }, { deleteChatSdkIdentityCache })
    ).resolves.toEqual({ success: true });

    expect(deleteChatSdkIdentityCache).toHaveBeenCalledWith('tenant-a');
    const remainingRows = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.TEAMS),
          eq(platform_integrations.owned_by_user_id, user.id)
        )
      );
    expect(remainingRows).toHaveLength(0);
  });
});
