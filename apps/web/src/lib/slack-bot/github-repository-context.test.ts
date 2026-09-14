import { captureException } from '@sentry/nextjs';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import {
  getGitHubRepositoryContext,
  resolveGitHubRepositoryForOwner,
} from './github-repository-context';

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getAllIntegrationsForOwner: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const mockCaptureException = jest.mocked(captureException);

beforeEach(() => mockCaptureException.mockClear());

test('lists the healthy sibling while excluding unhealthy GitHub associations', async () => {
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([
    {
      id: 'association-suspended',
      platform: 'github',
      integration_status: 'suspended',
      github_disconnected_at: '2026-09-07T00:00:00.000Z',
      suspended_at: '2026-09-07T00:00:00.000Z',
      auth_invalid_at: null,
      platform_account_login: 'private-owner',
      repository_access: 'selected',
      repositories_synced_at: '2026-09-07T00:00:00.000Z',
      repositories: [{ id: 1, name: 'private', full_name: 'private-owner/private', private: true }],
    },
    {
      id: 'association-auth-invalid',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: '2026-09-07T00:00:00.000Z',
      repositories: [{ id: 2, name: 'invalid', full_name: 'acme/invalid', private: true }],
    },
    {
      id: 'association-disconnected',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: '2026-09-07T00:00:00.000Z',
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 3, name: 'gone', full_name: 'acme/gone', private: true }],
    },
    {
      id: 'association-healthy',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 4, name: 'healthy', full_name: 'acme/healthy', private: true }],
    },
  ] as never);
  await expect(getGitHubRepositoryContext({ type: 'user', id: 'user-1' })).resolves.toEqual({
    repositories: [
      expect.objectContaining({
        full_name: 'acme/healthy',
        githubIntegrationId: 'association-healthy',
      }),
    ],
  });
  await expect(
    resolveGitHubRepositoryForOwner({ type: 'user', id: 'user-1' }, 'acme/healthy')
  ).resolves.toMatchObject({ githubIntegrationId: 'association-healthy' });
  await expect(
    resolveGitHubRepositoryForOwner({ type: 'user', id: 'user-1' }, 'acme/invalid')
  ).resolves.toBeNull();
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
      repositories: [{ id: 1, name: 'api', full_name: 'Shared/API', private: true }],
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
    resolveGitHubRepositoryForOwner({ type: 'org', id: 'organization-1' }, 'SHARED/api')
  ).resolves.toBeNull();
});

test('matches GitHub repository names case-insensitively', async () => {
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([
    {
      id: 'association-a',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 1, name: 'Repo', full_name: 'Acme/Repo', private: true }],
    },
  ] as never);

  await expect(
    resolveGitHubRepositoryForOwner({ type: 'org', id: 'organization-1' }, 'acme/repo')
  ).resolves.toMatchObject({ githubIntegrationId: 'association-a' });
});

test('isolates malformed repository caches from healthy sibling associations', async () => {
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([
    {
      id: 'association-string-id',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: '1', name: 'bad', full_name: 'acme/bad', private: true }],
    },
    {
      id: 'association-non-array',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: { id: 2 },
    },
    {
      id: 'association-null-entry',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [null],
    },
    {
      id: 'association-malformed-fields',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 3, name: 'bad', full_name: 3, private: 'yes' }],
    },
    {
      id: 'association-missing-id',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ name: 'bad', full_name: 'acme/bad2', private: true }],
    },
    {
      id: 'association-healthy',
      platform: 'github',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 4, name: 'good', full_name: 'acme/good', private: true }],
    },
  ] as never);

  await expect(getGitHubRepositoryContext({ type: 'org', id: 'organization-1' })).resolves.toEqual({
    repositories: [
      expect.objectContaining({
        full_name: 'acme/good',
        githubIntegrationId: 'association-healthy',
      }),
    ],
  });
  expect(mockCaptureException).toHaveBeenCalledTimes(5);
});

test('retains the real adapter-written repository cache shape', async () => {
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([
    {
      id: 'association-adapter',
      platform: 'github',
      integration_status: 'active',
      github_app_type: 'standard',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [
        {
          id: 42,
          name: 'cloud',
          full_name: 'Kilo-Org/cloud',
          private: true,
          created_at: '2024-01-02T03:04:05Z',
          future_cache_field: 'ignored',
        },
      ],
    },
  ] as never);

  await expect(getGitHubRepositoryContext({ type: 'org', id: 'organization-1' })).resolves.toEqual({
    repositories: [
      {
        id: 42,
        name: 'cloud',
        full_name: 'Kilo-Org/cloud',
        private: true,
        githubIntegrationId: 'association-adapter',
        githubAppType: 'standard',
      },
    ],
  });
  expect(mockCaptureException).not.toHaveBeenCalled();

  await expect(
    resolveGitHubRepositoryForOwner({ type: 'org', id: 'organization-1' }, 'kilo-org/cloud')
  ).resolves.toMatchObject({
    id: 42,
    githubIntegrationId: 'association-adapter',
    githubAppType: 'standard',
  });
});

test('keeps the same canonical repository associated to each Kilo owner separately', async () => {
  const repository = { id: 7, name: 'shared', full_name: 'acme/shared', private: true };
  jest
    .mocked(getAllIntegrationsForOwner)
    .mockResolvedValueOnce([
      {
        id: 'association-owner-a',
        platform: 'github',
        integration_status: 'active',
        github_disconnected_at: null,
        suspended_at: null,
        auth_invalid_at: null,
        repositories: [repository],
      },
    ] as never)
    .mockResolvedValueOnce([
      {
        id: 'association-owner-b',
        platform: 'github',
        integration_status: 'active',
        github_disconnected_at: null,
        suspended_at: null,
        auth_invalid_at: null,
        repositories: [repository],
      },
    ] as never);

  await expect(
    resolveGitHubRepositoryForOwner({ type: 'org', id: 'owner-a' }, repository.full_name)
  ).resolves.toMatchObject({ githubIntegrationId: 'association-owner-a' });
  await expect(
    resolveGitHubRepositoryForOwner({ type: 'org', id: 'owner-b' }, repository.full_name)
  ).resolves.toMatchObject({ githubIntegrationId: 'association-owner-b' });
});
