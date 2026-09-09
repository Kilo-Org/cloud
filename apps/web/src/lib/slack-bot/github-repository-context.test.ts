import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { getGitHubRepositoryContext } from './github-repository-context';

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: jest.fn(),
}));

test('does not expose cached repository context from a disconnected association', async () => {
  jest.mocked(getIntegrationForOwner).mockResolvedValue({
    integration_status: 'suspended',
    github_disconnected_at: '2026-09-07T00:00:00.000Z',
    suspended_at: '2026-09-07T00:00:00.000Z',
    auth_invalid_at: null,
    platform_account_login: 'private-owner',
    repository_access: 'selected',
    repositories_synced_at: '2026-09-07T00:00:00.000Z',
    repositories: [{ id: 1, name: 'private', full_name: 'private-owner/private', private: true }],
  } as never);
  await expect(getGitHubRepositoryContext({ type: 'user', id: 'user-1' })).resolves.toEqual({
    accountLogin: null,
    repositoryAccess: null,
    repositoriesSyncedAt: null,
    repositories: null,
  });
});
