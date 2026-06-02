import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { PLATFORM, INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { LinearWorkspaceAlreadyConnectedError, upsertLinearInstallation } from './linear-service';

describe('upsertLinearInstallation', () => {
  let user: User;
  let otherUser: User;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'linear-upsert@example.com',
      google_user_name: 'Linear Upsert',
    });
    otherUser = await insertTestUser({
      google_user_email: 'linear-upsert-other@example.com',
      google_user_name: 'Linear Other',
    });
  });

  beforeEach(() => {
    // Stub revoke endpoint so revokeLinearToken doesn't hit the network.
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await db
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.LINEAR),
          eq(platform_integrations.owned_by_user_id, user.id)
        )
      );
    await db
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.LINEAR),
          eq(platform_integrations.owned_by_user_id, otherUser.id)
        )
      );
  });

  test('inserts a new row when no existing installation', async () => {
    const result = await upsertLinearInstallation({
      owner: { type: 'user', id: user.id },
      organizationId: 'workspace-a',
      organizationName: 'Workspace A',
      botUserId: 'bot-1',
    });

    expect(result.platform_installation_id).toBe('workspace-a');
    expect(result.platform_account_login).toBe('Workspace A');
    expect(result.integration_status).toBe(INTEGRATION_STATUS.ACTIVE);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        model_slug: DEFAULT_BOT_MODEL,
      })
    );
  });

  test('rejects when another owner already holds the same Linear workspace', async () => {
    await upsertLinearInstallation({
      owner: { type: 'user', id: user.id },
      organizationId: 'workspace-shared',
      organizationName: 'Shared Workspace',
      botUserId: 'bot-1',
    });

    await expect(
      upsertLinearInstallation({
        owner: { type: 'user', id: otherUser.id },
        organizationId: 'workspace-shared',
        organizationName: 'Shared Workspace',
        botUserId: 'bot-2',
      })
    ).rejects.toBeInstanceOf(LinearWorkspaceAlreadyConnectedError);
  });

  test('reinstalling onto a different workspace cleans up the previous workspace', async () => {
    await upsertLinearInstallation({
      owner: { type: 'user', id: user.id },
      organizationId: 'workspace-a',
      organizationName: 'Workspace A',
      botUserId: 'bot-1',
    });

    const accessTokenCalls: string[] = [];
    const deleteInstallationCalls: string[] = [];
    const deleteIdentityCacheCalls: string[] = [];

    await upsertLinearInstallation(
      {
        owner: { type: 'user', id: user.id },
        organizationId: 'workspace-b',
        organizationName: 'Workspace B',
        botUserId: 'bot-2',
      },
      {
        getChatSdkAccessToken: async (orgId: string) => {
          accessTokenCalls.push(orgId);
          return 'old-token';
        },
        deleteChatSdkInstallation: async (orgId: string) => {
          deleteInstallationCalls.push(orgId);
        },
        deleteChatSdkIdentityCache: async (orgId: string) => {
          deleteIdentityCacheCalls.push(orgId);
        },
      }
    );

    expect(accessTokenCalls).toEqual(['workspace-a']);
    expect(deleteInstallationCalls).toEqual(['workspace-a']);
    expect(deleteIdentityCacheCalls).toEqual(['workspace-a']);

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, PLATFORM.LINEAR),
          eq(platform_integrations.owned_by_user_id, user.id)
        )
      );
    expect(row.platform_installation_id).toBe('workspace-b');
    expect(row.platform_account_login).toBe('Workspace B');
  });

  test('reinstalling onto the same workspace skips cleanup callbacks', async () => {
    await upsertLinearInstallation({
      owner: { type: 'user', id: user.id },
      organizationId: 'workspace-a',
      organizationName: 'Workspace A',
      botUserId: 'bot-1',
    });

    const calls: string[] = [];

    await upsertLinearInstallation(
      {
        owner: { type: 'user', id: user.id },
        organizationId: 'workspace-a',
        organizationName: 'Workspace A Renamed',
        botUserId: 'bot-1',
      },
      {
        getChatSdkAccessToken: async (orgId: string) => {
          calls.push(orgId);
          return null;
        },
        deleteChatSdkInstallation: async () => undefined,
        deleteChatSdkIdentityCache: async () => undefined,
      }
    );

    expect(calls).toEqual([]);
  });
});
