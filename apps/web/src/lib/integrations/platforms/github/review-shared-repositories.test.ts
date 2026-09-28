const sharedAssociation = {
  integration: {
    owned_by_user_id: null,
    owned_by_organization_id: 'org-b',
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    github_disconnected_at: null,
    github_connection_role: 'agent_only',
    github_installation_id: '00000000-0000-4000-8000-000000000001',
  },
  installation: {
    lifecycle_state: 'active',
    sharing_mode: 'web_cloud_agent',
    suspended_at: null,
    deleted_at: null,
    auth_invalid_at: null,
  },
  organizationDeletedAt: null,
  userRecordId: null,
  userBlockedReason: null,
};
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => {
      const query = {
        from: () => query,
        leftJoin: () => query,
        where: () => query,
        limit: async () => [sharedAssociation],
      };
      return query;
    },
  },
}));
jest.mock('@/lib/utils.server', () => ({ logExceptInTest: jest.fn() }));
jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: () => ({ appId: '1', privateKey: 'test' }),
}));
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async () => ({ token: 'test-installation-token' }),
}));
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    apps: {
      listReposAccessibleToInstallation: async () => ({
        data: {
          repositories: [
            { id: 1, name: 'repo', full_name: 'acme/repo', private: true, archived: false },
          ],
        },
      }),
    },
  })),
}));
import { fetchGitHubRepositories } from './adapter';
test('fetches inventory for an exact secondary association only with an approved purpose', async () => {
  await expect(
    fetchGitHubRepositories('123456', 'standard', '00000000-0000-4000-8000-000000000002')
  ).rejects.toThrow('unavailable');
  await expect(
    fetchGitHubRepositories(
      '123456',
      'standard',
      '00000000-0000-4000-8000-000000000002',
      'management'
    )
  ).resolves.toHaveLength(1);
});
