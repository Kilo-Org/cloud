import { afterEach, describe, expect, it } from '@jest/globals';
import { eq, inArray } from 'drizzle-orm';
import { kilocode_users, platform_integrations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { upsertSlackInstallation } from './slack-service';
import { INTEGRATION_STATUS, PLATFORM } from './core/constants';
import {
  getPlatformIntegration,
  getPlatformIntegrationById,
  PlatformIntegrationUnavailableError,
} from '@/lib/bot/platform-helpers';

jest.mock('@/lib/integrations/platforms/slack/credential-store', () => ({
  writeSlackCredential: async () => ({ id: 'credential-1' }),
}));

const DETACHED_AT = '2026-10-20T00:00:00.000Z';

function suspendedWorkspaceRow(userId: string, accountId: string, accountLogin: string) {
  return {
    owned_by_user_id: userId,
    platform: PLATFORM.SLACK,
    integration_type: 'oauth',
    platform_installation_id: null,
    platform_account_id: accountId,
    platform_account_login: accountLogin,
    scopes: [],
    integration_status: INTEGRATION_STATUS.SUSPENDED,
    suspended_at: DETACHED_AT,
    suspended_by: 'duplicate_slack_workspace_migration',
    metadata: {
      access_token: 'xoxb-detached-token',
      bot_user_id: 'U_OLD_BOT',
      duplicate_slack_platform_installation_id: accountId,
      duplicate_slack_platform_installation_detached_at: DETACHED_AT,
    },
  } satisfies typeof platform_integrations.$inferInsert;
}

const testUserIds: string[] = [];

describe('Slack workspace re-authorization', () => {
  afterEach(async () => {
    if (testUserIds.length > 0) {
      await db
        .delete(platform_integrations)
        .where(inArray(platform_integrations.owned_by_user_id, testUserIds));
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, testUserIds));
      testUserIds.length = 0;
    }
  });

  it('makes bot lookups available after the owner re-authorizes the workspace', async () => {
    const owner = await insertTestUser();
    testUserIds.push(owner.id);
    const [suspended] = await db
      .insert(platform_integrations)
      .values(suspendedWorkspaceRow(owner.id, 'T0RESTORE', 'Restore Workspace'))
      .returning();

    await expect(getPlatformIntegrationById(suspended.id)).rejects.toThrow(
      PlatformIntegrationUnavailableError
    );

    await upsertSlackInstallation({
      owner: { type: 'user', id: owner.id },
      teamId: 'T0RESTORE',
      installation: {
        botToken: 'xoxb-authorized-token',
        botUserId: 'U_BOT',
        teamName: 'Restore Workspace',
      },
    });

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, suspended.id));

    expect(row).toMatchObject({
      integration_status: INTEGRATION_STATUS.ACTIVE,
      suspended_at: null,
      suspended_by: null,
      platform_installation_id: 'T0RESTORE',
    });

    await expect(
      getPlatformIntegration({
        platform: PLATFORM.SLACK,
        teamId: 'T0RESTORE',
        userId: 'U_BOT',
      })
    ).resolves.toMatchObject({ id: suspended.id, integration_status: INTEGRATION_STATUS.ACTIVE });

    await expect(getPlatformIntegrationById(suspended.id)).resolves.toMatchObject({
      id: suspended.id,
      integration_status: INTEGRATION_STATUS.ACTIVE,
    });
  });

  it('limits lifecycle updates to the workspace being re-authorized', async () => {
    const owner = await insertTestUser();
    const otherOwner = await insertTestUser();
    testUserIds.push(owner.id, otherOwner.id);

    const [ownSuspended] = await db
      .insert(platform_integrations)
      .values(suspendedWorkspaceRow(owner.id, 'T0KEEP', 'Owner Workspace'))
      .returning();
    const [otherSuspended] = await db
      .insert(platform_integrations)
      .values(suspendedWorkspaceRow(otherOwner.id, 'T0OTHER', 'Other Workspace'))
      .returning();

    await upsertSlackInstallation({
      owner: { type: 'user', id: owner.id },
      teamId: 'T0KEEP',
      installation: {
        botToken: 'xoxb-authorized-token',
        botUserId: 'U_BOT',
        teamName: 'Owner Workspace',
      },
    });

    await expect(getPlatformIntegrationById(ownSuspended.id)).resolves.toMatchObject({
      integration_status: INTEGRATION_STATUS.ACTIVE,
    });

    await expect(getPlatformIntegrationById(otherSuspended.id)).rejects.toThrow(
      PlatformIntegrationUnavailableError
    );
    await expect(
      getPlatformIntegration({
        platform: PLATFORM.SLACK,
        teamId: 'T0OTHER',
        userId: 'U_OLD_BOT',
      })
    ).resolves.toBeNull();

    const [otherRow] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, otherSuspended.id));
    expect(otherRow).toMatchObject({
      integration_status: INTEGRATION_STATUS.SUSPENDED,
      suspended_by: 'duplicate_slack_workspace_migration',
      platform_installation_id: null,
    });
    expect(otherRow?.suspended_at).not.toBeNull();
  });
});
