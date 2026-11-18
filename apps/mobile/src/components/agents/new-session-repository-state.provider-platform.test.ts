import { describe, expect, it } from 'vitest';

import { detectRepositoryPlatform } from './new-session-repository-state';

describe('detectRepositoryPlatform', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'github'],
    ['git@gitlab.com:owner/repo.git', 'gitlab'],
    ['git@bitbucket.org:owner/repo.git', 'bitbucket'],
    ['https://github.com/owner/repo.git', 'github'],
    ['https://gitlab.com/owner/repo.git', 'gitlab'],
    ['https://bitbucket.org/owner/repo.git', 'bitbucket'],
    ['ssh://git@github.com/owner/repo.git', 'github'],
  ] as const)('resolves %s', (gitUrl, platform) => {
    expect(detectRepositoryPlatform(gitUrl)).toBe(platform);
  });

  // Both URL forms name the same repository, so neither may depend on the
  // host's letter case.
  it.each([
    ['git@GitHub.com:owner/repo.git', 'github'],
    ['git@GitLab.com:owner/repo.git', 'gitlab'],
    ['git@Bitbucket.org:owner/repo.git', 'bitbucket'],
    ['https://GitHub.com/owner/repo.git', 'github'],
    ['https://GitLab.com/owner/repo.git', 'gitlab'],
    ['https://Bitbucket.org/owner/repo.git', 'bitbucket'],
    ['ssh://git@GitHub.com/owner/repo.git', 'github'],
    ['ssh://git@GitLab.com/owner/repo.git', 'gitlab'],
  ] as const)('resolves %s regardless of host letter case', (gitUrl, platform) => {
    expect(detectRepositoryPlatform(gitUrl)).toBe(platform);
  });

  it('drops a self-hosted or unknown host in either URL form', () => {
    expect(detectRepositoryPlatform('git@git.example.com:owner/repo.git')).toBeUndefined();
    expect(detectRepositoryPlatform('https://git.example.com/owner/repo.git')).toBeUndefined();
  });

  it('drops a missing or unparseable repository URL', () => {
    expect(detectRepositoryPlatform(null)).toBeUndefined();
    expect(detectRepositoryPlatform(undefined)).toBeUndefined();
    expect(detectRepositoryPlatform('')).toBeUndefined();
    expect(detectRepositoryPlatform('owner/repo')).toBeUndefined();
  });
});
