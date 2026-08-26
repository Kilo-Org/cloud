import { describe, expect, it } from 'vitest';

import {
  dedupeRepositoriesByPlatformAndFullName,
  type NewSessionRepository,
  type RepositoryGroup,
  resolveBitbucketStatus,
  resolveProviderStatus,
  resolveRepositoryGroups,
} from './new-session-repository-state';

describe('resolveProviderStatus', () => {
  it('returns loading while the provider query is loading', () => {
    expect(
      resolveProviderStatus({
        isLoading: true,
        isError: false,
        integrationInstalled: true,
        repositoryCount: 5,
      })
    ).toBe('loading');
  });

  it('returns error when the query failed with no cached repos', () => {
    expect(
      resolveProviderStatus({
        isLoading: false,
        isError: true,
        integrationInstalled: undefined,
        repositoryCount: 0,
      })
    ).toBe('error');
  });

  it('keeps cached repos visible after a background refetch error', () => {
    expect(
      resolveProviderStatus({
        isLoading: false,
        isError: true,
        integrationInstalled: undefined,
        repositoryCount: 3,
      })
    ).toBe('repos');
  });

  it('returns connect when the provider is not installed', () => {
    expect(
      resolveProviderStatus({
        isLoading: false,
        isError: false,
        integrationInstalled: false,
        repositoryCount: 0,
      })
    ).toBe('connect');
  });

  it('returns connected-empty when installed but no repos are visible', () => {
    expect(
      resolveProviderStatus({
        isLoading: false,
        isError: false,
        integrationInstalled: true,
        repositoryCount: 0,
      })
    ).toBe('connected-empty');
  });

  it('returns repos when installed with repos visible', () => {
    expect(
      resolveProviderStatus({
        isLoading: false,
        isError: false,
        integrationInstalled: true,
        repositoryCount: 3,
      })
    ).toBe('repos');
  });
});

describe('resolveBitbucketStatus', () => {
  it('returns loading while the query is loading', () => {
    expect(
      resolveBitbucketStatus({
        isLoading: true,
        isError: false,
        status: undefined,
        repositoryCount: 0,
      })
    ).toBe('loading');
  });

  it('returns connect for a not_connected status', () => {
    expect(
      resolveBitbucketStatus({
        isLoading: false,
        isError: false,
        status: 'not_connected',
        repositoryCount: 0,
      })
    ).toBe('connect');
  });

  it('returns error for temporarily_unavailable', () => {
    expect(
      resolveBitbucketStatus({
        isLoading: false,
        isError: false,
        status: 'temporarily_unavailable',
        repositoryCount: 0,
      })
    ).toBe('error');
  });

  it('returns connected-empty when available with no repos', () => {
    expect(
      resolveBitbucketStatus({
        isLoading: false,
        isError: false,
        status: 'available',
        repositoryCount: 0,
      })
    ).toBe('connected-empty');
  });

  it('returns repos when available with repos', () => {
    expect(
      resolveBitbucketStatus({
        isLoading: false,
        isError: false,
        status: 'available',
        repositoryCount: 2,
      })
    ).toBe('repos');
  });
});

const github = (fullName: string): NewSessionRepository => ({
  platform: 'github',
  fullName,
  isPrivate: false,
});
const gitlab = (fullName: string): NewSessionRepository => ({
  platform: 'gitlab',
  fullName,
  isPrivate: false,
});

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
  const githubRow: NewSessionRepository = {
    platform: 'github',
    fullName: 'owner/repo',
    isPrivate: false,
  };

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
});
