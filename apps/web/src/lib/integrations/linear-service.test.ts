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

  test('reinstalling onto a different workspace persists new state inside admission', async () => {
    await upsertLinearInstallation({
      owner: { type: 'user', id: user.id },
      organizationId: 'workspace-a',
      organizationName: 'Workspace A',
      botUserId: 'bot-1',
    });

    const persistInstallation = jest.fn(async () => undefined);

    await upsertLinearInstallation(
      {
        owner: { type: 'user', id: user.id },
        organizationId: 'workspace-b',
        organizationName: 'Workspace B',
        botUserId: 'bot-2',
      },
      {
        persistInstallation,
      }
    );

    expect(persistInstallation).toHaveBeenCalledTimes(1);

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

  test('reinstalling onto the same workspace persists refreshed state', async () => {
    await upsertLinearInstallation({
      owner: { type: 'user', id: user.id },
      organizationId: 'workspace-a',
      organizationName: 'Workspace A',
      botUserId: 'bot-1',
    });

    const persistInstallation = jest.fn(async () => undefined);

    await upsertLinearInstallation(
      {
        owner: { type: 'user', id: user.id },
        organizationId: 'workspace-a',
        organizationName: 'Workspace A Renamed',
        botUserId: 'bot-1',
      },
      {
        persistInstallation,
      }
    );

    expect(persistInstallation).toHaveBeenCalledTimes(1);
  });

  test('removes a new admission when Chat SDK persistence fails after commit', async () => {
    await expect(
      upsertLinearInstallation(
        {
          owner: { type: 'user', id: user.id },
          organizationId: 'workspace-failed',
          organizationName: 'Workspace Failed',
          botUserId: 'bot-1',
        },
        { persistInstallation: async () => Promise.reject(new Error('redis unavailable')) }
      )
    ).rejects.toThrow('redis unavailable');
    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_user_id, user.id))
    ).resolves.toHaveLength(0);
  });
});
