import { describe, expect, it } from '@jest/globals';
import {
  readWorktreeSnapshotMeta,
  repositoryKey,
  repositoryKeyFromGitUrl,
  shortBranchRef,
} from './worktree-meta';

describe('repositoryKey', () => {
  it('includes the provider host so equal full names do not collide', () => {
    expect(repositoryKeyFromGitUrl('https://github.com/acme/repo.git')).toBe(
      'github.com/acme/repo'
    );
    expect(repositoryKeyFromGitUrl('git@gitlab.com:acme/repo.git')).toBe('gitlab.com/acme/repo');
    expect(repositoryKeyFromGitUrl('https://gitlab.com/acme/repo')).not.toBe(
      repositoryKeyFromGitUrl('https://github.com/acme/repo')
    );
  });

  it('uses the git URL over a display full name and keeps the platform fallback', () => {
    expect(
      repositoryKey({
        gitUrl: 'https://bitbucket.org/acme/repo.git',
        repository: 'acme/repo',
        platform: 'github',
      })
    ).toBe('bitbucket.org/acme/repo');
    expect(repositoryKey({ repository: 'acme/repo', platform: 'github' })).toBe('github:acme/repo');
  });
});

describe('snapshot metadata', () => {
  it('reads base fallback fields defensively', () => {
    expect(
      readWorktreeSnapshotMeta({
        comparison: { baseRefFallback: { requested: 'main', used: 'trunk' } },
      })
    ).toEqual({
      baseRefFallback: { requested: 'main', used: 'trunk' },
    });
    expect(readWorktreeSnapshotMeta({})).toEqual({
      baseRefFallback: null,
    });
  });

  it('normalizes remote and local branch refs', () => {
    expect(shortBranchRef('refs/remotes/origin/feat/a')).toBe('feat/a');
    expect(shortBranchRef('origin/feat/a')).toBe('feat/a');
    expect(shortBranchRef('feat/a')).toBe('feat/a');
    expect(shortBranchRef(null)).toBeNull();
  });
});
