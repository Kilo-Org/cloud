import { describe, expect, it } from 'vitest';
import { type LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';
import {
  dedupeRepositoriesByPlatformAndFullName,
  normalizeSessionRepository,
  type RepositoryGroup,
  resolveBitbucketStatus,
  resolveProviderStatus,
  resolveRepositoryGroups,
} from './new-session-repository-state';

describe('resolveProviderStatus', () => {
  it.each<[Partial<Parameters<typeof resolveProviderStatus>[0]>, string]>([
    [{ isLoading: true, repositoryCount: 5 }, 'loading'],
    [{ isError: true, integrationInstalled: undefined }, 'error'],
    [{ isError: true, integrationInstalled: undefined, repositoryCount: 3 }, 'error'],
    [{ integrationInstalled: false }, 'connect'],
    [{ integrationInstalled: false, isError: true }, 'connect'],
    [{ integrationInstalled: false, isError: true, isLoading: true }, 'connect'],
    [{}, 'connected-empty'],
    [{ repositoryCount: 3 }, 'repos'],
    [{ errorCode: 'FORBIDDEN' }, 'access-denied'],
    [{ errorCode: 'BAD_REQUEST' }, 'access-denied'],
    [{ errorCode: 'UNAUTHORIZED' }, 'connect'],
    [{ errorCode: 'PRECONDITION_FAILED' }, 'connect'],
    [{ hasUnresolved: true }, 'identity-unavailable'],
  ])('maps %j to the distinct recovery state %s', (input, expected) => {
    expect(
      resolveProviderStatus({
        isLoading: false,
        isError: false,
        integrationInstalled: true,
        repositoryCount: 0,
        ...input,
      })
    ).toBe(expected);
  });
});

describe('resolveBitbucketStatus', () => {
  it.each<[Partial<Parameters<typeof resolveBitbucketStatus>[0]>, string]>([
    [{ isLoading: true, status: undefined }, 'loading'],
    [{ status: undefined }, 'loading'],
    [{ status: 'not_connected' }, 'connect'],
    [{ status: 'workspace_selection_required' }, 'connect'],
    [{ status: 'reconnect_required' }, 'connect'],
    [{ status: 'temporarily_unavailable' }, 'error'],
    [{ isError: true, repositoryCount: 3 }, 'error'],
    [{}, 'connected-empty'],
    [{ repositoryCount: 2 }, 'repos'],
    [{ status: 'insufficient_permissions' }, 'access-denied'],
    [{ status: 'invalid_request' }, 'access-denied'],
    [{ errorCode: 'FORBIDDEN' }, 'access-denied'],
    [{ errorCode: 'UNAUTHORIZED' }, 'connect'],
    [{ hasUnresolved: true }, 'identity-unavailable'],
  ])('maps %j to the distinct recovery state %s', (input, expected) => {
    expect(
      resolveBitbucketStatus({
        isLoading: false,
        isError: false,
        status: 'available',
        repositoryCount: 0,
        ...input,
      })
    ).toBe(expected);
  });
});

function repository(platform: 'github' | 'gitlab', fullName: string) {
  const row = normalizeSessionRepository(
    {
      private: false,
      repositoryReference: {
        repository: {
          provider: platform,
          fullName,
          instanceUrl: `https://${platform}.com`,
          repositoryId: '1',
          defaultBranch: null,
        },
        authorization: {
          kind: 'ownerIntegration',
          owner: { type: 'org', id: 'org-1' },
          integrationId: 'integration-1',
        },
      },
    },
    'user-1',
    'org-1'
  );
  if (!row) {
    throw new Error('Invalid repository fixture');
  }
  return row;
}
const github = (fullName: string) => repository('github', fullName);
const gitlab = (fullName: string) => repository('gitlab', fullName);

describe('dedupeRepositoriesByPlatformAndFullName', () => {
  it('keeps the same fullName on two platforms as two rows', () => {
    const deduped = dedupeRepositoriesByPlatformAndFullName([
      github('owner/repo'),
      gitlab('owner/repo'),
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.map(repo => repo.platform)).toEqual(['github', 'gitlab']);
  });

  it('collapses duplicate rows that share platform and fullName', () => {
    const deduped = dedupeRepositoriesByPlatformAndFullName([
      github('owner/repo'),
      github('owner/repo'),
    ]);
    expect(deduped).toHaveLength(1);
  });
});

const group = (
  key: RepositoryGroup['key'],
  overrides: Partial<RepositoryGroup> = {}
): RepositoryGroup => ({
  key,
  status: 'repos',
  repositories: [],
  ...overrides,
});

describe('resolveRepositoryGroups', () => {
  const githubRow = github('owner/repo');

  it('hides the Bitbucket group when no organization is set', () => {
    const { groups } = resolveRepositoryGroups({
      organizationId: undefined,
      github: group('github', { repositories: [githubRow] }),
      gitlab: group('gitlab', { status: 'connect' }),
      bitbucket: group('bitbucket'),
      recents: [],
    });
    expect(groups.map(g => g.key)).toEqual(['github', 'gitlab']);
  });

  it('keeps GitHub rows when the GitLab group errors', () => {
    const { groups } = resolveRepositoryGroups({
      organizationId: 'org-1',
      github: group('github', { status: 'repos', repositories: [githubRow] }),
      gitlab: group('gitlab', { status: 'error' }),
      bitbucket: group('bitbucket', { status: 'connect' }),
      recents: [],
    });
    const githubGroup = groups.find(g => g.key === 'github');
    const gitlabGroup = groups.find(g => g.key === 'gitlab');
    expect(githubGroup?.status).toBe('repos');
    expect(githubGroup?.repositories).toEqual([githubRow]);
    expect(gitlabGroup?.status).toBe('error');
  });

  it.each<[RepositoryGroup['status'], boolean]>([
    ['loading', true],
    ['error', true],
    ['identity-unavailable', true],
    ['connect', false],
    ['access-denied', false],
  ])('keeps cached rows and recents usable only when %s permits it', (status, retain) => {
    const result = resolveRepositoryGroups({
      organizationId: 'org-1',
      github: group('github', { status, repositories: [githubRow] }),
      gitlab: group('gitlab', { status: 'connected-empty' }),
      bitbucket: group('bitbucket', { status: 'connect' }),
      recents: [githubRow],
    });
    expect(result.groups[0]?.repositories).toEqual(retain ? [githubRow] : []);
    expect(result.recents).toEqual(retain ? [githubRow] : []);
  });
});

const reference: LaunchRepositoryReference = {
  repository: {
    provider: 'gitlab',
    instanceUrl: 'https://git.example.com/base',
    repositoryId: '42',
    fullName: 'group/nested/Repo',
    defaultBranch: 'develop',
  },
  authorization: {
    kind: 'ownerIntegration',
    owner: { type: 'org', id: 'org-1' },
    integrationId: 'integration-1',
  },
};

it('keeps every identity component distinct through normalization and deduplication', () => {
  const variants: LaunchRepositoryReference[] = [
    reference,
    {
      ...reference,
      authorization: { ...reference.authorization, owner: { type: 'user', id: 'user-1' } },
    },
    {
      ...reference,
      authorization: { ...reference.authorization, owner: { type: 'org', id: 'org-2' } },
    },
    { ...reference, authorization: { ...reference.authorization, integrationId: 'integration-2' } },
    {
      ...reference,
      repository: { ...reference.repository, instanceUrl: 'https://git.example.com/other' },
    },
    { ...reference, repository: { ...reference.repository, repositoryId: '43' } },
    { ...reference, repository: { ...reference.repository, fullName: 'group/nested/repo' } },
    {
      ...reference,
      repository: {
        provider: 'github',
        instanceUrl: reference.repository.instanceUrl,
        repositoryId: '42',
        fullName: reference.repository.fullName,
        defaultBranch: null,
      },
    },
    {
      ...reference,
      repository: {
        provider: 'bitbucket',
        instanceUrl: 'https://bitbucket.org',
        repositoryId: 'repo-uuid',
        workspaceUuid: 'workspace-1',
        fullName: 'team/repo',
        defaultBranch: 'release',
      },
    },
    {
      ...reference,
      repository: {
        provider: 'bitbucket',
        instanceUrl: 'https://bitbucket.org',
        repositoryId: 'repo-uuid',
        workspaceUuid: 'workspace-2',
        fullName: 'team/repo',
        defaultBranch: 'release',
      },
    },
  ];
  const rows = variants.map(ref =>
    normalizeSessionRepository(
      { private: true, repositoryReference: ref },
      'user-1',
      ref.authorization.owner.type === 'org' ? ref.authorization.owner.id : undefined
    )
  );
  const account = normalizeSessionRepository(
    { private: true, repositoryReference: reference },
    'user-2',
    'org-1'
  );
  const resolved = [...rows, account].filter(row => row !== null);
  expect(resolved).toHaveLength(variants.length + 1);
  expect(dedupeRepositoriesByPlatformAndFullName([...resolved, ...resolved])).toEqual(resolved);
  expect(resolved[0]?.reference.repository.defaultBranch).toBe('develop');
  expect(resolved[8]).toMatchObject({ workspaceUuid: 'workspace-1', repositoryUuid: 'repo-uuid' });
});

it('quarantines missing identity, wrong owners, and Personal Bitbucket without inventing a reference', () => {
  expect(normalizeSessionRepository({ private: true }, 'user-1', 'org-1')).toBeNull();
  expect(
    normalizeSessionRepository({ private: true, repositoryReference: reference }, 'user-1', 'org-2')
  ).toBeNull();
  expect(
    normalizeSessionRepository(
      { private: true, repositoryReference: reference },
      undefined,
      'org-1'
    )
  ).toBeNull();
  expect(
    normalizeSessionRepository(
      {
        private: true,
        repositoryReference: {
          repository: {
            provider: 'bitbucket',
            instanceUrl: 'https://bitbucket.org',
            repositoryId: 'repo',
            workspaceUuid: 'workspace',
            fullName: 'team/repo',
            defaultBranch: null,
          },
          authorization: {
            kind: 'ownerIntegration',
            owner: { type: 'user', id: 'user-1' },
            integrationId: 'integration-1',
          },
        },
      },
      'user-1',
      undefined
    )
  ).toBeNull();
});
