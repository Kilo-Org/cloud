import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { kilocode_users, platform_integrations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import type * as GitLabAdapter from '@/lib/integrations/platforms/gitlab/adapter';
import type { fetchGitLabCredential as FetchGitLabCredential } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
import type * as GitLabService from './gitlab-service';

const mockFetchGitLabProjects = jest.fn<typeof GitLabAdapter.fetchGitLabProjects>();
const mockFetchGitLabCredential = jest.fn<typeof FetchGitLabCredential>();

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  ...jest.requireActual<typeof GitLabAdapter>('@/lib/integrations/platforms/gitlab/adapter'),
  fetchGitLabProjects: mockFetchGitLabProjects,
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  resetCodeReviewConfigForOwner: jest.fn(async () => undefined),
}));

jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: mockFetchGitLabCredential,
}));

let listGitLabRepositories: typeof GitLabService.listGitLabRepositories;

describe('listGitLabRepositories', () => {
  type IntegrationRow = typeof platform_integrations.$inferInsert;

  const providerProject = {
    id: 77,
    name: 'project',
    full_name: 'group/project',
    private: true,
  };

  beforeAll(async () => {
    ({ listGitLabRepositories } = await import('./gitlab-service'));
  });

  beforeEach(() => {
    mockFetchGitLabProjects.mockReset();
    mockFetchGitLabCredential.mockReset();
    mockFetchGitLabCredential.mockResolvedValue({
      status: 'available',
      token: 'glpat-test-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: false,
    });
  });

  async function insertIntegration(overrides: Partial<IntegrationRow> = {}) {
    const user = await insertTestUser();
    const [row] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'pat',
        integration_status: 'active',
        repository_access: 'all',
        metadata: { gitlab_instance_url: 'https://gitlab.com', auth_type: 'pat' },
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

  it('answers a synced empty snapshot without resolving a credential or reading the provider', async () => {
    const { user, row } = await insertIntegration({
      repositories: [],
      repositories_synced_at: '2026-10-01T00:00:00.000Z',
    });

    try {
      await expect(
        listGitLabRepositories({ type: 'user', id: user.id }, row.id, { userId: user.id })
      ).resolves.toEqual({
        repositories: [],
        syncedAt: row.repositories_synced_at,
      });
      expect(mockFetchGitLabCredential).not.toHaveBeenCalled();
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();

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
    mockFetchGitLabProjects.mockResolvedValueOnce([providerProject]);

    try {
      const result = await listGitLabRepositories(
        { type: 'user', id: user.id },
        row.id,
        { userId: user.id },
        true
      );

      expect(mockFetchGitLabProjects).toHaveBeenCalledTimes(1);
      expect(result.repositories).toEqual([providerProject]);

      const after = await readRow(row.id);
      expect(after?.repositories).toEqual([providerProject]);
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
    mockFetchGitLabProjects.mockResolvedValueOnce([]);

    try {
      await expect(
        listGitLabRepositories({ type: 'user', id: user.id }, row.id, { userId: user.id })
      ).resolves.toMatchObject({ repositories: [] });
      expect(mockFetchGitLabProjects).toHaveBeenCalledTimes(1);

      const after = await readRow(row.id);
      expect(after?.repositories).toEqual([]);
      expect(after?.repositories_synced_at).not.toBeNull();
    } finally {
      await cleanup(user.id);
    }
  });

  it('answers a non-empty snapshot without resolving a credential or reading the provider', async () => {
    const { user, row } = await insertIntegration({
      repositories: [providerProject],
      repositories_synced_at: '2026-10-01T00:00:00.000Z',
    });

    try {
      await expect(
        listGitLabRepositories({ type: 'user', id: user.id }, row.id, { userId: user.id })
      ).resolves.toEqual({
        repositories: [providerProject],
        syncedAt: row.repositories_synced_at,
      });
      expect(mockFetchGitLabCredential).not.toHaveBeenCalled();
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
    } finally {
      await cleanup(user.id);
    }
  });
});
