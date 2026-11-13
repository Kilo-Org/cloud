import { beforeEach, describe, expect, it } from '@jest/globals';
const mockDeleteGitHubInstallation = jest.fn();
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  ...(jest.requireActual('@/lib/integrations/platforms/github/adapter') as object),
  deleteGitHubInstallation: (...args: unknown[]) => mockDeleteGitHubInstallation(...args),
  fetchGitHubRepositories: jest.fn(),
}));
import {
  github_app_installations,
  kilocode_users,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { fetchGitHubRepositories } from '@/lib/integrations/platforms/github/adapter';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  getPrimaryGitHubIntegrationForOrganization,
} from '@/lib/integrations/db/platform-integrations';
import {
  cancelPendingInstallation,
  checkUserPendingInstallation,
  getInstallation,
  isInstallationGoneError,
  listNativelyUninstallableIds,
  listRepositories,
  uninstallApp,
  updateModel,
} from './github-apps-service';

const mockFetchGitHubRepositories = jest.mocked(fetchGitHubRepositories);

describe('getInstallation', () => {
  it('prefers a healthy installation when the owner has multiple GitHub rows', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub installation ${crypto.randomUUID()}` })
      .returning();
    const rows = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          github_connection_role: 'workflow',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
          suspended_at: new Date().toISOString(),
        },
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          github_connection_role: 'workflow',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
        },
      ])
      .returning();

    try {
      const integration = await getInstallation({ type: 'org', id: organization.id });
      const sharedIntegration = await getIntegrationForOrganization(organization.id, 'github');

      expect(integration?.id).toBe(rows[1].id);
      expect(sharedIntegration?.id).toBe(rows[1].id);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('keeps the oldest healthy organization installation primary', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub primary ${crypto.randomUUID()}` })
      .returning();
    const oldestCreatedAt = '2026-01-01T00:00:00.000Z';
    const newestCreatedAt = '2026-02-01T00:00:00.000Z';
    const rows = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          github_connection_role: 'workflow',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
          created_at: oldestCreatedAt,
        },
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          github_connection_role: 'workflow',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
          created_at: newestCreatedAt,
        },
      ])
      .returning();

    try {
      const integration = await getInstallation({ type: 'org', id: organization.id });
      expect(integration?.id).toBe(rows[0].id);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('keeps an auth-invalid installation visible without selecting it as primary', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub recovery ${crypto.randomUUID()}` })
      .returning();
    const [row] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        github_connection_role: 'workflow',
        integration_type: 'app',
        platform_installation_id: crypto.randomUUID(),
        integration_status: 'active',
        repository_access: 'all',
        auth_invalid_at: new Date().toISOString(),
        auth_invalid_reason: 'installation_token_auth_failed',
      })
      .returning();

    try {
      const visibleIntegration = await getIntegrationForOrganization(organization.id, 'github');
      const primaryIntegration = await getPrimaryGitHubIntegrationForOrganization(organization.id);
      const ownerIntegration = await getIntegrationForOwner(
        { type: 'org', id: organization.id },
        'github'
      );

      expect(visibleIntegration?.id).toBe(row.id);
      expect(primaryIntegration).toBeNull();
      expect(ownerIntegration).toBeNull();
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});

describe('updateModel', () => {
  it('updates only the targeted installation when integrationId is provided', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub model ${crypto.randomUUID()}` })
      .returning();
    const rows = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
        },
        {
          owned_by_organization_id: organization.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          integration_status: 'active',
          repository_access: 'all',
        },
      ])
      .returning();

    try {
      const result = await updateModel(
        { type: 'org', id: organization.id },
        'anthropic/claude-sonnet-5',
        rows[1].id
      );

      expect(result).toEqual({ success: true });

      const [updated] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, rows[1].id));
      const [untouched] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, rows[0].id));

      expect((updated?.metadata as Record<string, unknown> | null)?.model_slug).toBe(
        'anthropic/claude-sonnet-5'
      );
      expect(untouched?.metadata).toBeNull();
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });

  it('returns an error when no installation matches the owner and integrationId', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub model missing ${crypto.randomUUID()}` })
      .returning();

    try {
      const result = await updateModel(
        { type: 'org', id: organization.id },
        'anthropic/claude-sonnet-5',
        crypto.randomUUID()
      );

      expect(result).toEqual({ success: false, error: 'No GitHub App installation found' });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});

describe('pending installation selection', () => {
  type PendingRow = typeof platform_integrations.$inferInsert;

  function pendingRow(input: { userId: string; accountId: string; createdAt: string }): PendingRow {
    return {
      owned_by_user_id: input.userId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: null,
      integration_status: 'pending',
      github_app_type: 'standard',
      platform_account_id: input.accountId,
      platform_account_login: `target-${input.accountId}`,
      kilo_requester_user_id: input.userId,
      installed_at: input.createdAt,
      created_at: input.createdAt,
      updated_at: input.createdAt,
    };
  }

  async function cleanupUser(userId: string): Promise<void> {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }

  it('returns the newest pending request regardless of the order rows were written', async () => {
    const user = await insertTestUser();
    try {
      // The older request is written first, so an unordered SELECT returns it.
      const rows = await db
        .insert(platform_integrations)
        .values([
          pendingRow({
            userId: user.id,
            accountId: 'older',
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
          pendingRow({
            userId: user.id,
            accountId: 'newer',
            createdAt: '2026-02-01T00:00:00.000Z',
          }),
        ])
        .returning();

      const [older, newer] = rows;

      await expect(checkUserPendingInstallation(user.id)).resolves.toMatchObject({ id: newer.id });

      // Touching the older row moves it to the end of the heap, flipping the
      // physical order a second time; the answer must not follow it.
      await db
        .update(platform_integrations)
        .set({ updated_at: '2026-03-01T00:00:00.000Z' })
        .where(eq(platform_integrations.id, older.id));

      await expect(checkUserPendingInstallation(user.id)).resolves.toMatchObject({ id: newer.id });
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('breaks equal pending creation times by descending integration id', async () => {
    const user = await insertTestUser();
    const [lowerId, higherId] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    const createdAt = '2026-02-01T00:00:00.000Z';
    try {
      await db.insert(platform_integrations).values([
        {
          ...pendingRow({ userId: user.id, accountId: 'lower-id', createdAt }),
          id: lowerId,
        },
        {
          ...pendingRow({ userId: user.id, accountId: 'higher-id', createdAt }),
          id: higherId,
        },
      ]);

      await expect(checkUserPendingInstallation(user.id)).resolves.toMatchObject({ id: higherId });

      await cancelPendingInstallation({ type: 'user', id: user.id }, higherId);

      await expect(checkUserPendingInstallation(user.id)).resolves.toMatchObject({ id: lowerId });
    } finally {
      await cleanupUser(user.id);
    }
  });

  it('cancels exactly the named pending request and refuses any other id', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    try {
      const rows = await db
        .insert(platform_integrations)
        .values([
          pendingRow({
            userId: user.id,
            accountId: 'first',
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
          pendingRow({
            userId: user.id,
            accountId: 'second',
            createdAt: '2026-02-01T00:00:00.000Z',
          }),
        ])
        .returning();
      const [first, second] = rows;

      await cancelPendingInstallation({ type: 'user', id: user.id }, first.id);

      const remaining = await db
        .select({ id: platform_integrations.id })
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_user_id, user.id));
      expect(remaining).toEqual([{ id: second.id }]);

      await expect(
        cancelPendingInstallation({ type: 'user', id: otherUser.id }, second.id)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const stillPending = await db
        .select({ id: platform_integrations.id })
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_user_id, user.id));
      expect(stillPending).toEqual([{ id: second.id }]);
    } finally {
      await cleanupUser(user.id);
      await cleanupUser(otherUser.id);
    }
  });
});

describe('isInstallationGoneError', () => {
  it('should return true for 404 Not Found errors', () => {
    const error = { status: 404, message: 'Not Found' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return true for 401 Unauthorized errors', () => {
    const error = { status: 401, message: 'Unauthorized' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return true for 403 Forbidden errors', () => {
    const error = { status: 403, message: 'Forbidden' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return false for 500 Internal Server Error', () => {
    const error = { status: 500, message: 'Internal Server Error' };
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for 502 Bad Gateway', () => {
    const error = { status: 502, message: 'Bad Gateway' };
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for errors without status property', () => {
    const error = new Error('Some error');
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for null', () => {
    expect(isInstallationGoneError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isInstallationGoneError(undefined)).toBe(false);
  });

  it('should return false for string errors', () => {
    expect(isInstallationGoneError('Not Found')).toBe(false);
  });

  it('should return false for number errors', () => {
    expect(isInstallationGoneError(404)).toBe(false);
  });
});

describe('listRepositories', () => {
  type IntegrationRow = typeof platform_integrations.$inferInsert;

  beforeEach(() => {
    mockFetchGitHubRepositories.mockReset();
  });

  const providerRepository = {
    id: 42,
    name: 'widgets',
    full_name: 'acme/widgets',
    private: false,
    created_at: '2026-05-01T00:00:00.000Z',
  };

  async function insertIntegration(overrides: Partial<IntegrationRow> = {}) {
    const user = await insertTestUser();
    const [row] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: crypto.randomUUID(),
        integration_status: 'active',
        repository_access: 'all',
        ...overrides,
      })
      .returning();
    return { user, row };
  }

  async function readRow(id: string) {
    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, id));
    return row;
  }

  async function cleanup(userId: string) {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }

  it('answers a synced empty snapshot without reading the provider or writing the row', async () => {
    const { user, row } = await insertIntegration({
      repositories: [],
      repositories_synced_at: '2026-10-01T00:00:00.000Z',
    });

    try {
      await expect(listRepositories({ type: 'user', id: user.id }, row.id)).resolves.toEqual({
        repositories: [],
        syncedAt: row.repositories_synced_at,
      });
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();

      const after = await readRow(row.id);
      expect(after?.repositories).toEqual([]);
      expect(after?.repositories_synced_at).toBe(row.repositories_synced_at);
    } finally {
      await cleanup(user.id);
    }
  });

  it('reads the provider and stores the new snapshot on an explicit refresh', async () => {
    const { user, row } = await insertIntegration({
      repositories: [],
      repositories_synced_at: '2026-10-01T00:00:00.000Z',
    });
    mockFetchGitHubRepositories.mockResolvedValueOnce([providerRepository]);

    try {
      const result = await listRepositories({ type: 'user', id: user.id }, row.id, true);

      expect(mockFetchGitHubRepositories).toHaveBeenCalledTimes(1);
      expect(result.repositories).toEqual([providerRepository]);

      const after = await readRow(row.id);
      expect(after?.repositories).toEqual([providerRepository]);
      expect(after?.repositories_synced_at).not.toBe(row.repositories_synced_at);
    } finally {
      await cleanup(user.id);
    }
  });

  it('reads the provider for a row that has never produced a snapshot', async () => {
    const { user, row } = await insertIntegration({
      repositories: [],
      repositories_synced_at: null,
    });
    mockFetchGitHubRepositories.mockResolvedValueOnce([providerRepository]);

    try {
      const result = await listRepositories({ type: 'user', id: user.id }, row.id);

      expect(mockFetchGitHubRepositories).toHaveBeenCalledTimes(1);
      expect(result.repositories).toEqual([providerRepository]);

      const after = await readRow(row.id);
      expect(after?.repositories).toEqual([providerRepository]);
      expect(after?.repositories_synced_at).not.toBeNull();
    } finally {
      await cleanup(user.id);
    }
  });

  it('answers a non-empty snapshot without reading the provider', async () => {
    const { user, row } = await insertIntegration({
      repositories: [providerRepository],
      repositories_synced_at: '2026-10-01T00:00:00.000Z',
    });

    try {
      await expect(listRepositories({ type: 'user', id: user.id }, row.id)).resolves.toEqual({
        repositories: [providerRepository],
        syncedAt: row.repositories_synced_at,
      });
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    } finally {
      await cleanup(user.id);
    }
  });
});

describe('uninstallApp', () => {
  it('returns a fixed message when the provider rejects the deletion', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub uninstall ${crypto.randomUUID()}` })
      .returning();
    const [row] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'github',
        github_connection_role: 'workflow',
        integration_type: 'app',
        platform_installation_id: crypto.randomUUID(),
        integration_status: 'active',
        repository_access: 'all',
      })
      .returning();
    const upstreamFailure = new Error('upstream refused for installation install-8f21');
    mockDeleteGitHubInstallation.mockRejectedValueOnce(upstreamFailure);

    try {
      await expect(
        uninstallApp(
          { type: 'org', id: organization.id },
          row.id,
          'user-for-uninstall-test',
          'user@example.com',
          'Test User'
        )
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to delete GitHub installation',
      });
      expect(mockDeleteGitHubInstallation).toHaveBeenCalledWith(
        row.platform_installation_id,
        'standard'
      );
    } finally {
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});

describe('listNativelyUninstallableIds', () => {
  type IntegrationRow = typeof platform_integrations.$inferInsert;

  // The canonical installation table only accepts GitHub's numeric ids.
  function installationNumber(): string {
    return String(Math.floor(Math.random() * 1e15) + 1);
  }

  async function insertInstallation(appType: 'standard' | 'lite') {
    const [installation] = await db
      .insert(github_app_installations)
      .values({ github_app_type: appType, installation_id: installationNumber() })
      .returning();
    return installation;
  }

  async function insertRow(overrides: Partial<IntegrationRow>) {
    const user = await insertTestUser();
    const [row] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: crypto.randomUUID(),
        integration_status: 'active',
        repository_access: 'all',
        ...overrides,
      })
      .returning();
    return { user, row };
  }

  async function cleanup(userIds: readonly string[]) {
    for (const userId of userIds) {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_user_id, userId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  }

  it('counts only a workflow connection whose installation has no local sibling', async () => {
    const installation = await insertInstallation('standard');
    const workflow = await insertRow({ github_connection_role: 'workflow' });
    const agentOnly = await insertRow({
      github_connection_role: 'agent_only',
      github_installation_id: installation.id,
    });

    try {
      const ids = await listNativelyUninstallableIds([workflow.row, agentOnly.row]);
      expect([...ids]).toEqual([workflow.row.id]);
    } finally {
      await cleanup([workflow.user.id, agentOnly.user.id]);
      await db
        .delete(github_app_installations)
        .where(eq(github_app_installations.id, installation.id));
    }
  });

  it('counts a null app type with standard on both sides of the comparison', async () => {
    const shared = crypto.randomUUID();
    const blocked = await insertRow({
      github_connection_role: 'workflow',
      platform_installation_id: shared,
      github_app_type: null,
    });
    const legacySibling = await insertRow({
      platform_installation_id: shared,
      github_app_type: 'standard',
    });
    const alone = await insertRow({
      github_connection_role: 'workflow',
      platform_installation_id: crypto.randomUUID(),
      github_app_type: null,
    });

    try {
      const ids = await listNativelyUninstallableIds([blocked.row, alone.row]);
      expect([...ids]).toEqual([alone.row.id]);
    } finally {
      await cleanup([blocked.user.id, legacySibling.user.id, alone.user.id]);
    }
  });

  it('counts one installation shared with another owner as busy', async () => {
    const installationId = crypto.randomUUID();
    const workflow = await insertRow({
      github_connection_role: 'workflow',
      platform_installation_id: installationId,
    });
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub shared ${crypto.randomUUID()}` })
      .returning();
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: installationId,
      integration_status: 'active',
      repository_access: 'all',
    });

    try {
      await expect(listNativelyUninstallableIds([workflow.row])).resolves.toEqual(new Set());
    } finally {
      await cleanup([workflow.user.id]);
      await db.delete(organizations).where(eq(organizations.id, organization.id));
    }
  });
});
