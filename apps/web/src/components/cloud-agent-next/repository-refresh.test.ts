import { describe, expect, it, jest } from '@jest/globals';
import {
  refreshSessionRepositories,
  shouldIncludeBitbucketRepositoryRefresh,
} from './repository-refresh';

describe('refreshSessionRepositories', () => {
  it('refreshes Bitbucket repositories when an organization refresh is available', async () => {
    const refreshGitHubRepositories = jest.fn<() => Promise<void>>(() => Promise.resolve());
    const refreshGitLabRepositories = jest.fn<() => Promise<void>>(() => Promise.resolve());
    const refreshBitbucketRepositories = jest.fn<() => Promise<void>>(() => Promise.resolve());

    await refreshSessionRepositories({
      refreshGitHubRepositories,
      refreshGitLabRepositories,
      refreshBitbucketRepositories,
    });

    expect(refreshGitHubRepositories).toHaveBeenCalledTimes(1);
    expect(refreshGitLabRepositories).toHaveBeenCalledTimes(1);
    expect(refreshBitbucketRepositories).toHaveBeenCalledTimes(1);
  });

  it('includes Bitbucket refresh for available and temporarily unavailable repository state only', () => {
    expect(shouldIncludeBitbucketRepositoryRefresh('available')).toBe(true);
    expect(shouldIncludeBitbucketRepositoryRefresh('temporarily_unavailable')).toBe(true);
    expect(shouldIncludeBitbucketRepositoryRefresh('not_connected')).toBe(false);
    expect(shouldIncludeBitbucketRepositoryRefresh(undefined)).toBe(false);
  });
});
