import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import {
  getGitHubRepositoryContext,
  resolveGitHubRepositoryForOwner,
} from './github-repository-context';

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getAllIntegrationsForOwner: jest.fn(),
}));

test('does not expose cached repository context from a disconnected association', async () => {
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([
    {
      integration_status: 'suspended',
      github_disconnected_at: '2026-09-07T00:00:00.000Z',
      suspended_at: '2026-09-07T00:00:00.000Z',
      auth_invalid_at: null,
      platform_account_login: 'private-owner',
      repository_access: 'selected',
      repositories_synced_at: '2026-09-07T00:00:00.000Z',
      repositories: [{ id: 1, name: 'private', full_name: 'private-owner/private', private: true }],
    } as never,
  ]);
  await expect(getGitHubRepositoryContext({ type: 'user', id: 'user-1' })).resolves.toEqual({
    repositories: null,
  });
});

test('retains association provenance across repository choices', async () => {
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([
    {
      id: 'association-a',
      platform: 'github',
      integration_status: 'active',
      github_app_type: 'standard',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 1, name: 'api', full_name: 'alpha/api', private: true }],
    },
    {
      id: 'association-b',
      platform: 'github',
      integration_status: 'active',
      github_app_type: 'lite',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 2, name: 'api', full_name: 'beta/api', private: true }],
    },
  ] as never);

  await expect(getGitHubRepositoryContext({ type: 'org', id: 'organization-1' })).resolves.toEqual({
    repositories: [
      expect.objectContaining({ full_name: 'alpha/api', githubIntegrationId: 'association-a' }),
      expect.objectContaining({ full_name: 'beta/api', githubIntegrationId: 'association-b' }),
    ],
  });
  await expect(
    resolveGitHubRepositoryForOwner({ type: 'org', id: 'organization-1' }, 'alpha/api')
  ).resolves.toMatchObject({
    githubIntegrationId: 'association-a',
  });
});

test('rejects a repository exposed by multiple associations', async () => {
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([
    {
      id: 'association-a',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 1, name: 'api', full_name: 'shared/api', private: true }],
    },
    {
      id: 'association-b',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 2, name: 'api', full_name: 'shared/api', private: true }],
    },
  ] as never);

  await expect(
    resolveGitHubRepositoryForOwner({ type: 'org', id: 'organization-1' }, 'shared/api')
  ).resolves.toBeNull();
});
