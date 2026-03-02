import {
  formatGitLabRepositoriesForPrompt,
  type GitLabRepositoryContext,
} from './gitlab-repository-context';

describe('formatGitLabRepositoriesForPrompt', () => {
  test('shows account, instance, and repository list when repos are available', () => {
    const context: GitLabRepositoryContext = {
      accountLogin: 'gitlab-user',
      repositoryAccess: 'selected',
      repositoriesSyncedAt: '2024-01-15T10:00:00Z',
      instanceUrl: 'https://gitlab.com',
      repositories: [
        { id: 1, name: 'project-a', full_name: 'mygroup/project-a', private: false },
        { id: 2, name: 'project-b', full_name: 'mygroup/subgroup/project-b', private: true },
      ],
    };

    const result = formatGitLabRepositoriesForPrompt(context);

    expect(result).toContain('GitLab repository context');
    expect(result).toContain('Account: gitlab-user');
    expect(result).toContain('Instance: gitlab.com');
    expect(result).toContain('Repository access: selected');
    expect(result).toContain('Repositories synced at: 2024-01-15T10:00:00Z');
    expect(result).toContain('mygroup/project-a [id: 1]');
    expect(result).toContain('mygroup/subgroup/project-b (private) [id: 2]');
    expect(result).toContain('nested groups');
  });

  test('shows "all access" message when repositoryAccess is "all" and no repos listed', () => {
    const context: GitLabRepositoryContext = {
      accountLogin: 'gitlab-user',
      repositoryAccess: 'all',
      repositoriesSyncedAt: null,
      instanceUrl: 'https://gitlab.com',
      repositories: [],
    };

    const result = formatGitLabRepositoriesForPrompt(context);

    expect(result).toContain('not stored for "all" access');
    expect(result).toContain('group/project format');
  });

  test('shows "no repos connected" when no integration repos and access is not "all"', () => {
    const context: GitLabRepositoryContext = {
      accountLogin: null,
      repositoryAccess: null,
      repositoriesSyncedAt: null,
      instanceUrl: null,
      repositories: null,
    };

    const result = formatGitLabRepositoriesForPrompt(context);

    expect(result).toContain('No GitLab repositories are currently connected');
  });

  test('redacts self-hosted instance URL to prevent leaking internal hostnames', () => {
    const context: GitLabRepositoryContext = {
      accountLogin: 'admin',
      repositoryAccess: 'selected',
      repositoriesSyncedAt: null,
      instanceUrl: 'https://gitlab.example.com',
      repositories: [{ id: 10, name: 'internal', full_name: 'team/internal', private: true }],
    };

    const result = formatGitLabRepositoriesForPrompt(context);

    expect(result).toContain('Instance: self-hosted GitLab');
    expect(result).not.toContain('gitlab.example.com');
    expect(result).toContain('team/internal (private) [id: 10]');
  });

  test('handles null repositories the same as empty array', () => {
    const contextNull: GitLabRepositoryContext = {
      accountLogin: 'user',
      repositoryAccess: 'selected',
      repositoriesSyncedAt: null,
      instanceUrl: 'https://gitlab.com',
      repositories: null,
    };

    const contextEmpty: GitLabRepositoryContext = {
      ...contextNull,
      repositories: [],
    };

    const resultNull = formatGitLabRepositoriesForPrompt(contextNull);
    const resultEmpty = formatGitLabRepositoriesForPrompt(contextEmpty);

    expect(resultNull).toContain('No GitLab repositories are currently connected');
    expect(resultEmpty).toContain('No GitLab repositories are currently connected');
  });
});
