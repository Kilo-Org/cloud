import { describe, expect, it } from 'vitest';
import {
  isSafeRepositoryLeaf,
  repositoryLeaf,
  resolveEnvironmentIdentity,
} from './environment-contracts';
import {
  environmentRepositoriesSchema,
  environmentRepositoryEntrySchema,
} from './environment-repository-entry';

const WORKSPACE_UUID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const REPOSITORY_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const github = (repoFullName: string) => ({ platform: 'github' as const, repoFullName });

function errorMessages(input: unknown): string[] {
  const result = environmentRepositoriesSchema.safeParse(input);
  if (result.success) throw new Error('expected the list to be rejected');
  return result.error.issues.map(issue => issue.message);
}

describe('repositoryLeaf', () => {
  it('is the last path segment', () => {
    expect(repositoryLeaf('acme/widgets')).toBe('widgets');
    expect(repositoryLeaf('group/sub/project')).toBe('project');
    expect(repositoryLeaf('widgets')).toBe('widgets');
    expect(repositoryLeaf('acme/')).toBe('');
  });
});

describe('isSafeRepositoryLeaf', () => {
  it.each(['widgets', 'my-repo', 'my_repo', 'repo.js', '.github', 'a', 'Repo2', 'a'.repeat(255)])(
    'accepts %s',
    leaf => {
      expect(isSafeRepositoryLeaf(leaf)).toBe(true);
    }
  );

  it.each([
    ['empty', ''],
    ['dot', '.'],
    ['dot dot', '..'],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['leading dash', '-rf'],
    ['newline', 'a\nb'],
    ['NUL', 'a\u0000b'],
    ['tab', 'a\tb'],
    ['space', 'my repo'],
    ['non-ASCII', 'répo'],
    ['dot git', '.git'],
    ['dot GIT', '.GIT'],
    ['too long', 'a'.repeat(256)],
  ])('rejects %s', (_label, leaf) => {
    expect(isSafeRepositoryLeaf(leaf)).toBe(false);
  });
});

describe('environmentRepositoryEntrySchema', () => {
  it('normalizes identity values to the V1 column form', () => {
    expect(environmentRepositoryEntrySchema.parse(github('  Acme/Widgets '))).toEqual(
      github('acme/widgets')
    );
    expect(
      environmentRepositoryEntrySchema.parse({
        platform: 'gitlab',
        repoFullName: 'Group/Project',
        gitlabCloneUrl: ' https://gitlab.com/Group/Project.git ',
      })
    ).toEqual({
      platform: 'gitlab',
      repoFullName: 'group/project',
      gitlabCloneUrl: 'https://gitlab.com/Group/Project.git',
    });
    expect(
      environmentRepositoryEntrySchema.parse({
        platform: 'bitbucket',
        repoFullName: 'Team/Repo',
        bitbucketWorkspaceUuid: WORKSPACE_UUID,
        bitbucketRepositoryUuid: REPOSITORY_UUID,
      })
    ).toEqual({
      platform: 'bitbucket',
      repoFullName: 'team/repo',
      bitbucketWorkspaceUuid: WORKSPACE_UUID.toLowerCase(),
      bitbucketRepositoryUuid: REPOSITORY_UUID,
    });
  });

  it.each([
    ['github without repoFullName', { platform: 'github' }],
    ['github with a GitLab field', { ...github('a/b'), gitlabCloneUrl: 'https://x/y.git' }],
    ['gitlab without a clone URL', { platform: 'gitlab', repoFullName: 'a/b' }],
    [
      'bitbucket without repoFullName',
      {
        platform: 'bitbucket',
        bitbucketWorkspaceUuid: WORKSPACE_UUID,
        bitbucketRepositoryUuid: REPOSITORY_UUID,
      },
    ],
    [
      'bitbucket with a malformed UUID',
      {
        platform: 'bitbucket',
        repoFullName: 'a/b',
        bitbucketWorkspaceUuid: 'not-a-uuid',
        bitbucketRepositoryUuid: REPOSITORY_UUID,
      },
    ],
    ['an unknown platform', { platform: 'gitea', repoFullName: 'a/b' }],
    ['a blank repoFullName', github('   ')],
  ])('rejects %s', (_label, entry) => {
    expect(environmentRepositoryEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe('entry identity parity with the V1 columns', () => {
  const entryIdentity = (entry: Record<string, unknown>) => {
    const parsed = environmentRepositoryEntrySchema.parse(entry);
    return {
      repo_full_name: parsed.repoFullName,
      gitlab_clone_url: parsed.platform === 'gitlab' ? parsed.gitlabCloneUrl : null,
      bitbucket_workspace_uuid:
        parsed.platform === 'bitbucket' ? parsed.bitbucketWorkspaceUuid : null,
      bitbucket_repository_uuid:
        parsed.platform === 'bitbucket' ? parsed.bitbucketRepositoryUuid : null,
    };
  };

  it.each([
    { platform: 'github', repoFullName: '  Acme/Widgets  ' },
    {
      platform: 'gitlab',
      repoFullName: ' Group/Sub/Project ',
      gitlabCloneUrl: '  https://GitLab.com/Group/Sub/Project.git ',
    },
    {
      platform: 'bitbucket',
      repoFullName: ' Team/Repo ',
      bitbucketWorkspaceUuid: `  ${WORKSPACE_UUID}  `,
      bitbucketRepositoryUuid: ` ${REPOSITORY_UUID.toUpperCase()} `,
    },
  ] as const)('stores what resolveEnvironmentIdentity stores for $platform', input => {
    expect(entryIdentity(input)).toEqual(resolveEnvironmentIdentity(input));
  });
});

describe('environmentRepositoriesSchema', () => {
  it('accepts several repositories and keeps their order', () => {
    const list = [
      github('acme/widgets'),
      {
        platform: 'gitlab' as const,
        repoFullName: 'group/api',
        gitlabCloneUrl: 'https://gitlab.com/group/api.git',
      },
    ];
    expect(environmentRepositoriesSchema.parse(list)).toEqual(list);
  });

  it('rejects an empty list', () => {
    expect(errorMessages([])).toEqual(['An environment needs at least one repository']);
  });

  it('rejects a duplicate repository and names it', () => {
    expect(errorMessages([github('acme/widgets'), github('Acme/Widgets')])).toEqual([
      'Repository acme/widgets is listed more than once',
    ]);
  });

  it('rejects an unsafe leaf and names the repository', () => {
    expect(errorMessages([github('acme/..')])).toEqual([
      'Repository acme/.. cannot be checked out: its directory name ".." is unsafe',
    ]);
    expect(errorMessages([github('acme/')])).toEqual([
      'Repository acme/ cannot be checked out: its directory name "" is unsafe',
    ]);
    expect(errorMessages([github('acme/-rf')])).toEqual([
      'Repository acme/-rf cannot be checked out: its directory name "-rf" is unsafe',
    ]);
    expect(errorMessages([github('acme/.git')])).toEqual([
      'Repository acme/.git cannot be checked out: its directory name ".git" is unsafe',
    ]);
    expect(errorMessages([github('acme/.GIT')])).toEqual([
      'Repository acme/.git cannot be checked out: its directory name ".git" is unsafe',
    ]);
  });

  it('rejects a GitLab duplicate with a different name and names the second', () => {
    const gitlab = (repoFullName: string) => ({
      platform: 'gitlab' as const,
      repoFullName,
      gitlabCloneUrl: 'https://gitlab.com/group/project.git',
    });
    expect(errorMessages([gitlab('group/project'), gitlab('group/renamed')])).toEqual([
      'Repository group/renamed is listed more than once',
    ]);
  });

  it('rejects a Bitbucket duplicate with a different name and names the second', () => {
    const bitbucket = (repoFullName: string) => ({
      platform: 'bitbucket' as const,
      repoFullName,
      bitbucketWorkspaceUuid: WORKSPACE_UUID,
      bitbucketRepositoryUuid: REPOSITORY_UUID,
    });
    expect(errorMessages([bitbucket('team/repo'), bitbucket('team/renamed')])).toEqual([
      'Repository team/renamed is listed more than once',
    ]);
  });

  it('rejects two leaves that are equal without regard to case, naming both', () => {
    expect(errorMessages([github('acme/widgets'), github('other/widgets')])).toEqual([
      'Repositories acme/widgets and other/widgets use the same directory name "widgets"',
    ]);
  });

  it('compares leaves without regard to case in the input', () => {
    expect(errorMessages([github('acme/Widgets'), github('other/WIDGETS')])).toEqual([
      'Repositories acme/widgets and other/widgets use the same directory name "widgets"',
    ]);
  });

  it('accepts repositories with different leaves', () => {
    expect(
      environmentRepositoriesSchema.safeParse([github('acme/widgets'), github('acme/gadgets')])
        .success
    ).toBe(true);
  });
});
