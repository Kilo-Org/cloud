import { describe, expect, it, jest } from '@jest/globals';
import {
  refreshSessionRepositories,
  resolveRepositoryStatus,
  shouldCacheBitbucketRepositoryRefreshResult,
  shouldIncludeBitbucketRepositoryRefresh,
} from './repository-refresh';

describe('resolveRepositoryStatus', () => {
  type Status = { status: 'available' | 'unavailable' };

  it('uses the caller value and the cached status without loading', async () => {
    const load = jest.fn<() => Promise<Status>>(() => Promise.resolve({ status: 'unavailable' }));

    const fromOverride = await resolveRepositoryStatus({
      override: { status: 'available' },
      cached: undefined,
      load,
    });
    const fromCache = await resolveRepositoryStatus({
      override: undefined,
      cached: { status: 'available' },
      load,
    });

    expect(fromOverride).toEqual({ status: 'available' });
    expect(fromCache).toEqual({ status: 'available' });
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the status only when neither the caller nor the cache has one', async () => {
    const load = jest.fn<() => Promise<Status>>(() => Promise.resolve({ status: 'available' }));

    const resolved = await resolveRepositoryStatus({
      override: undefined,
      cached: undefined,
      load,
    });

    expect(resolved).toEqual({ status: 'available' });
    expect(load).toHaveBeenCalledTimes(1);
  });
});

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

  it('preserves cached Bitbucket repositories during temporary provider outages', () => {
    expect(shouldCacheBitbucketRepositoryRefreshResult('available')).toBe(true);
    expect(shouldCacheBitbucketRepositoryRefreshResult('reconnect_required')).toBe(true);
    expect(shouldCacheBitbucketRepositoryRefreshResult('temporarily_unavailable')).toBe(false);
  });
});
