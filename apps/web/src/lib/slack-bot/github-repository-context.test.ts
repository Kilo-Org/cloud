import { captureException } from '@sentry/nextjs';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
import {
  formatGitHubRepositoriesForPrompt,
  getGitHubRepositoryContext,
  resolveGitHubRepositoryForOwner,
  type GitHubRepositoryChoice,
} from './github-repository-context';
import {
  REPOSITORY_PROMPT_MAX_CHARACTERS,
  REPOSITORY_PROMPT_MAX_REPOSITORIES,
} from './repository-prompt-budget';

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
      github_connection_role: 'workflow',
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
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: '2026-09-07T00:00:00.000Z',
      repositories: [{ id: 2, name: 'invalid', full_name: 'acme/invalid', private: true }],
    },
    {
      id: 'association-disconnected',
      platform: 'github',
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_disconnected_at: '2026-09-07T00:00:00.000Z',
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 3, name: 'gone', full_name: 'acme/gone', private: true }],
    },
    {
      id: 'association-healthy',
      platform: 'github',
      github_connection_role: 'workflow',
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
      github_connection_role: 'workflow',
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
      github_connection_role: 'workflow',
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
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 1, name: 'api', full_name: 'Shared/API', private: true }],
    },
    {
      id: 'association-b',
      platform: 'github',
      github_connection_role: 'workflow',
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
      github_connection_role: 'workflow',
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
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: '1', name: 'bad', full_name: 'acme/bad', private: true }],
    },
    {
      id: 'association-non-array',
      platform: 'github',
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: { id: 2 },
    },
    {
      id: 'association-null-entry',
      platform: 'github',
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [null],
    },
    {
      id: 'association-malformed-fields',
      platform: 'github',
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ id: 3, name: 'bad', full_name: 3, private: 'yes' }],
    },
    {
      id: 'association-missing-id',
      platform: 'github',
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories: [{ name: 'bad', full_name: 'acme/bad2', private: true }],
    },
    {
      id: 'association-healthy',
      platform: 'github',
      github_connection_role: 'workflow',
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
      github_connection_role: 'workflow',
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
        github_connection_role: 'workflow',
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
        github_connection_role: 'agent_only',
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
    resolveGitHubRepositoryForOwner({ type: 'org', id: 'owner-b' }, repository.full_name, 'agent')
  ).resolves.toMatchObject({ githubIntegrationId: 'association-owner-b' });
});

function bulkRepositories(count: number): GitHubRepositoryChoice[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `repo-${index}`,
    full_name: `acme/repo-${index}`,
    private: false,
    githubIntegrationId: 'bulk',
    githubAppType: 'standard' as const,
  }));
}

test('bounds the prompt block to the listed cap and one overflow line', () => {
  const repositories = bulkRepositories(REPOSITORY_PROMPT_MAX_REPOSITORIES + 10);

  const result = formatGitHubRepositoriesForPrompt({ repositories });
  const resultLines = result.split('\n');
  const entryLines = resultLines.filter(line => /^- .*\[id: /.test(line));
  const overflowLine = resultLines.find(line => line.startsWith('- Repositories not listed here:'));

  expect(entryLines).toHaveLength(REPOSITORY_PROMPT_MAX_REPOSITORIES);
  expect(overflowLine).toBe(
    '- Repositories not listed here: 10. Ask the user for the exact owner/name of the repository they want to use.'
  );
  expect(result).toContain('Available repositories:');
  expect(result).toContain('infer the correct repository');
});

test('resolves a repository that falls outside the rendered subset', async () => {
  const repositories = bulkRepositories(REPOSITORY_PROMPT_MAX_REPOSITORIES + 10);
  const lastRepository = repositories[repositories.length - 1];
  jest.mocked(getAllIntegrationsForOwner).mockResolvedValue([
    {
      id: 'bulk',
      platform: 'github',
      github_connection_role: 'workflow',
      integration_status: 'active',
      github_app_type: 'standard',
      github_disconnected_at: null,
      suspended_at: null,
      auth_invalid_at: null,
      repositories,
    },
  ] as never);

  const owner = { type: 'org', id: 'organization-1' } as const;
  const context = await getGitHubRepositoryContext(owner);
  expect(context.repositories).toHaveLength(REPOSITORY_PROMPT_MAX_REPOSITORIES + 10);

  const prompt = formatGitHubRepositoriesForPrompt(context);
  expect(prompt).not.toContain(`${lastRepository.full_name} `);
  expect(prompt).toContain('Repositories not listed here: 10.');

  await expect(
    resolveGitHubRepositoryForOwner(owner, lastRepository.full_name)
  ).resolves.toMatchObject({
    full_name: lastRepository.full_name,
    githubIntegrationId: 'bulk',
  });
});

test('keeps the rendered prompt block within the character cap for long names', () => {
  const repositories: GitHubRepositoryChoice[] = Array.from({ length: 60 }, (_, index) => ({
    id: index + 1,
    name: `repo-${index}`,
    full_name: `acme/${'segment'.repeat(12)}/repo-${index}`,
    private: true,
    githubIntegrationId: 'bulk',
    githubAppType: 'standard' as const,
  }));

  const result = formatGitHubRepositoriesForPrompt({ repositories });
  const list = result.split('Available repositories:\n')[1].split('\n\nWhen the user asks')[0];
  const listLines = list.split('\n');
  const listed = listLines.length - 1;
  const omitted = Number(/^- Repositories not listed here: (\d+)\./.exec(listLines[listed])?.[1]);

  expect(list.length).toBeLessThanOrEqual(REPOSITORY_PROMPT_MAX_CHARACTERS);
  expect(listed).toBeLessThan(REPOSITORY_PROMPT_MAX_REPOSITORIES);
  expect(listed).toBeGreaterThan(0);
  expect(listed + omitted).toBe(repositories.length);
  expect(listLines[listed - 1]).toContain('[id: ');
  expect(result).toContain(
    'When the user asks you to work on code without specifying a repository'
  );
});
