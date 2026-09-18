import { describe, expect, it } from 'vitest';

import {
  bindingsForProfile,
  filterRepositoryOptions,
  findRepoBinding,
  mergeRepositoryOptions,
  repoPlatformBadge,
  repositoryOptionKey,
} from '@/components/profiles/repo-bindings-model';

const GITHUB = [
  { fullName: 'acme/api', private: true },
  { fullName: 'acme/web', private: false },
];
const GITLAB = [{ fullName: 'acme/infra', private: false }];

describe('mergeRepositoryOptions', () => {
  it('lists GitHub rows first, then GitLab, tagged with their platform', () => {
    expect(mergeRepositoryOptions(GITHUB, GITLAB)).toEqual([
      { platform: 'github', fullName: 'acme/api', private: true },
      { platform: 'github', fullName: 'acme/web', private: false },
      { platform: 'gitlab', fullName: 'acme/infra', private: false },
    ]);
  });

  it('returns an empty list when neither provider has rows', () => {
    expect(mergeRepositoryOptions([], [])).toEqual([]);
  });

  it('keeps the same full name on both platforms as two distinct options', () => {
    const merged = mergeRepositoryOptions(
      [{ fullName: 'acme/api', private: false }],
      [{ fullName: 'acme/api', private: true }]
    );
    expect(merged.map(repo => repositoryOptionKey(repo))).toEqual([
      'github:acme/api',
      'gitlab:acme/api',
    ]);
  });
});

describe('filterRepositoryOptions', () => {
  const options = mergeRepositoryOptions(GITHUB, GITLAB);

  it('returns every option for a blank or whitespace query', () => {
    expect(filterRepositoryOptions(options, '')).toHaveLength(3);
    expect(filterRepositoryOptions(options, '   ')).toHaveLength(3);
  });

  it('matches a full name case-insensitively', () => {
    expect(filterRepositoryOptions(options, 'API').map(repo => repo.fullName)).toEqual([
      'acme/api',
    ]);
    expect(filterRepositoryOptions(options, 'acme/').map(repo => repo.fullName)).toEqual([
      'acme/api',
      'acme/web',
      'acme/infra',
    ]);
  });

  it('returns no rows when nothing matches', () => {
    expect(filterRepositoryOptions(options, 'zzz')).toEqual([]);
  });
});

describe('findRepoBinding', () => {
  const bindings = [
    { repoFullName: 'Acme/API', platform: 'github', profileId: 'p1', profileName: 'One' },
    { repoFullName: 'acme/api', platform: 'gitlab', profileId: 'p2', profileName: 'Two' },
  ];

  it('matches platform and full name case-insensitively', () => {
    expect(findRepoBinding(bindings, 'acme/api', 'github')?.profileId).toBe('p1');
    expect(findRepoBinding(bindings, 'ACME/API', 'gitlab')?.profileId).toBe('p2');
  });

  it('does not match across platforms', () => {
    expect(findRepoBinding(bindings, 'acme/api', 'gitlab')?.profileId).toBe('p2');
    expect(findRepoBinding(bindings, 'acme/web', 'github')).toBeUndefined();
  });
});

describe('bindingsForProfile', () => {
  it('keeps only the bindings owned by the profile', () => {
    const bindings = [
      { repoFullName: 'a/one', platform: 'github', profileId: 'p1', profileName: 'One' },
      { repoFullName: 'a/two', platform: 'github', profileId: 'p2', profileName: 'Two' },
      { repoFullName: 'a/three', platform: 'gitlab', profileId: 'p1', profileName: 'One' },
    ];
    expect(bindingsForProfile(bindings, 'p1').map(binding => binding.repoFullName)).toEqual([
      'a/one',
      'a/three',
    ]);
  });
});

describe('repoPlatformBadge', () => {
  it('renders GL for GitLab and GH for GitHub and anything unknown', () => {
    expect(repoPlatformBadge('gitlab')).toBe('GL');
    expect(repoPlatformBadge('github')).toBe('GH');
    expect(repoPlatformBadge('bitbucket')).toBe('GH');
  });
});
