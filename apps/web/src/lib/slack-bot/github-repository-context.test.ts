import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db';
import type {
  getIntegrationForOwner,
  getIntegrationsByOrganization,
} from '@/lib/integrations/db/platform-integrations';
import type * as GitHubRepositoryContextModule from './github-repository-context';

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: jest.fn(),
  getIntegrationsByOrganization: jest.fn(),
}));

let formatGitHubRepositoriesForPrompt: typeof GitHubRepositoryContextModule.formatGitHubRepositoriesForPrompt;
let getGitHubRepositoryContext: typeof GitHubRepositoryContextModule.getGitHubRepositoryContext;
let resolveDisplayedGitHubIntegrationId: typeof GitHubRepositoryContextModule.resolveDisplayedGitHubIntegrationId;

function integration(overrides: Partial<PlatformIntegration>): PlatformIntegration {
  return {
    id: '123e4567-e89b-12d3-a456-426614174022',
    platform: 'github',
    integration_type: 'app',
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    platform_account_login: 'acme',
    repository_access: 'selected',
    repositories_synced_at: null,
    repositories: [{ id: 1, name: 'web', full_name: 'acme/web', private: true }],
    ...overrides,
  } as PlatformIntegration;
}

describe('GitHub repository context for chat bots', () => {
  beforeAll(async () => {
    ({
      formatGitHubRepositoriesForPrompt,
      getGitHubRepositoryContext,
      resolveDisplayedGitHubIntegrationId,
    } = await import('./github-repository-context'));
  });

  it('shows repositories from every healthy organization installation', async () => {
    const getIntegrationForOwnerMock = jest.fn<typeof getIntegrationForOwner>();
    const getIntegrationsByOrganizationMock = jest
      .fn<typeof getIntegrationsByOrganization>()
      .mockResolvedValue([
        integration({}),
        integration({
          id: '123e4567-e89b-12d3-a456-426614174023',
          platform_account_login: 'other',
          repositories: [{ id: 2, name: 'api', full_name: 'other/api', private: false }],
        }),
        integration({
          id: '123e4567-e89b-12d3-a456-426614174024',
          integration_status: 'suspended',
          suspended_at: '2026-08-27 07:00:00+00',
        }),
      ]);

    const context = await getGitHubRepositoryContext(
      { type: 'org', id: 'chat-workspace' },
      {
        getIntegrationForOwner: getIntegrationForOwnerMock,
        getIntegrationsByOrganization: getIntegrationsByOrganizationMock,
      }
    );
    const prompt = formatGitHubRepositoriesForPrompt(context);

    expect(context.installations).toHaveLength(2);
    expect(prompt).toContain('acme/web');
    expect(prompt).toContain('other/api');
    expect(prompt).toContain('Submit owner/repo and let Cloud Agent resolve and authorize it.');
  });

  it('keeps personal repository context on the existing single-integration path', async () => {
    const personalIntegration = integration({
      integration_status: 'suspended',
      suspended_at: '2026-08-27 07:00:00+00',
    });
    const getIntegrationForOwnerMock = jest
      .fn<typeof getIntegrationForOwner>()
      .mockResolvedValue(personalIntegration);

    const context = await getGitHubRepositoryContext(
      { type: 'user', id: 'user-1' },
      {
        getIntegrationForOwner: getIntegrationForOwnerMock,
        getIntegrationsByOrganization: jest.fn<typeof getIntegrationsByOrganization>(),
      }
    );

    expect(context.installations).toEqual([
      expect.objectContaining({ platformIntegrationId: personalIntegration.id }),
    ]);
  });
});

describe('displayed GitHub repository identity', () => {
  const firstId = '123e4567-e89b-12d3-a456-426614174022';
  const secondId = '123e4567-e89b-12d3-a456-426614174023';
  const repository = { id: 1, name: 'web', full_name: 'acme/web', private: true };

  it('omits an integration ID when the displayed repository is unique', () => {
    expect(
      resolveDisplayedGitHubIntegrationId(
        {
          installations: [
            {
              platformIntegrationId: firstId,
              accountLogin: 'acme',
              repositoryAccess: 'selected',
              repositoriesSyncedAt: null,
              repositories: [repository],
            },
          ],
        },
        'acme/web',
        firstId
      )
    ).toBeUndefined();
  });

  it('keeps only an ID belonging to a displayed duplicate choice', () => {
    const context = {
      installations: [firstId, secondId].map(platformIntegrationId => ({
        platformIntegrationId,
        accountLogin: 'acme',
        repositoryAccess: 'selected',
        repositoriesSyncedAt: null,
        repositories: [repository],
      })),
    };

    expect(resolveDisplayedGitHubIntegrationId(context, 'acme/web', secondId)).toBe(secondId);
    expect(() =>
      resolveDisplayedGitHubIntegrationId(
        context,
        'acme/web',
        '123e4567-e89b-12d3-a456-426614174024'
      )
    ).toThrow('does not match a displayed duplicate repository choice');
    expect(() => resolveDisplayedGitHubIntegrationId(context, 'other/repo', firstId)).toThrow(
      'does not match a displayed duplicate repository choice'
    );
  });
});
