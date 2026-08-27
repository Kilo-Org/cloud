import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db';
import type {
  getIntegrationForOwner,
  getIntegrationsByOrganization,
  resolveOrganizationGitHubIntegrationForRepository,
} from '@/lib/integrations/db/platform-integrations';
import {
  formatGitHubRepositoriesForPrompt,
  getGitHubRepositoryContext,
  resolveGitHubRepositorySelection,
  type GitHubRepositoryContext,
} from './github-repository-context';

const standardId = '123e4567-e89b-12d3-a456-426614174022';
const liteId = '123e4567-e89b-12d3-a456-426614174023';
const mockGetIntegrationForOwner = jest.fn<typeof getIntegrationForOwner>();
const mockGetIntegrationsByOrganization = jest.fn<typeof getIntegrationsByOrganization>();
const mockResolveOrganizationGitHubIntegrationForRepository =
  jest.fn<typeof resolveOrganizationGitHubIntegrationForRepository>();

function integration(overrides: Partial<PlatformIntegration>): PlatformIntegration {
  return {
    id: standardId,
    platform: 'github',
    integration_type: 'app',
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    platform_account_login: 'acme',
    repository_access: 'selected',
    repositories_synced_at: '2026-08-27T07:00:00.000Z',
    repositories: [{ id: 1, name: 'web', full_name: 'acme/web', private: true }],
    ...overrides,
  } as PlatformIntegration;
}

describe('GitHub repository context for chat bots', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('aggregates repositories across healthy organization installations with selection identity', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      integration({}),
      integration({
        id: liteId,
        platform_account_login: 'other',
        repositories: [{ id: 2, name: 'api', full_name: 'other/api', private: false }],
      }),
      integration({
        id: '123e4567-e89b-12d3-a456-426614174024',
        integration_status: 'suspended',
        suspended_at: '2026-08-27T07:00:00.000Z',
      }),
    ]);

    const context = await getGitHubRepositoryContext(
      { type: 'org', id: 'chat-workspace' },
      {
        getIntegrationForOwner: mockGetIntegrationForOwner,
        getIntegrationsByOrganization: mockGetIntegrationsByOrganization,
      }
    );

    expect(context.installations).toHaveLength(2);
    expect(formatGitHubRepositoriesForPrompt(context)).toContain(
      `other/api [repositoryId: 2; account: other; platformIntegrationId: ${liteId}]`
    );
  });

  it('preserves a listed repository account and integration id', async () => {
    const selected = integration({ id: liteId, platform_account_login: 'other' });
    const context: GitHubRepositoryContext = {
      installations: [
        {
          platformIntegrationId: liteId,
          accountLogin: 'other',
          repositoryAccess: 'selected',
          repositoriesSyncedAt: null,
          repositories: [{ id: 2, name: 'api', full_name: 'other/api', private: false }],
        },
      ],
    };
    mockResolveOrganizationGitHubIntegrationForRepository.mockResolvedValue({
      success: true,
      integration: selected,
    });

    await expect(
      resolveGitHubRepositorySelection(
        { type: 'org', id: 'chat-workspace' },
        { githubRepo: 'other/api', githubAccount: 'other', githubIntegrationId: liteId },
        context,
        mockResolveOrganizationGitHubIntegrationForRepository
      )
    ).resolves.toEqual({
      success: true,
      githubAccount: 'other',
      githubIntegrationId: liteId,
    });
    expect(mockResolveOrganizationGitHubIntegrationForRepository).toHaveBeenCalledWith({
      organizationId: 'chat-workspace',
      repositoryFullName: 'other/api',
      expectedPlatformIntegrationId: liteId,
    });
  });

  it('rejects an ambiguous manually supplied organization repository without applying its pin', async () => {
    mockResolveOrganizationGitHubIntegrationForRepository.mockResolvedValue({
      success: false,
      reason: 'ambiguous_installation',
    });
    const context: GitHubRepositoryContext = {
      installations: [
        {
          platformIntegrationId: standardId,
          accountLogin: 'acme',
          repositoryAccess: 'all',
          repositoriesSyncedAt: null,
          repositories: null,
        },
        {
          platformIntegrationId: liteId,
          accountLogin: 'acme',
          repositoryAccess: 'all',
          repositoriesSyncedAt: null,
          repositories: null,
        },
      ],
    };

    const result = await resolveGitHubRepositorySelection(
      { type: 'org', id: 'chat-workspace' },
      { githubRepo: 'acme/manual', githubAccount: 'acme', githubIntegrationId: standardId },
      context,
      mockResolveOrganizationGitHubIntegrationForRepository
    );

    expect(result).toEqual({
      success: false,
      error:
        'Multiple GitHub installations can access that repository. Select a repository entry with its account and platformIntegrationId.',
    });
    expect(mockResolveOrganizationGitHubIntegrationForRepository).toHaveBeenCalledWith({
      organizationId: 'chat-workspace',
      repositoryFullName: 'acme/manual',
    });
  });
});
