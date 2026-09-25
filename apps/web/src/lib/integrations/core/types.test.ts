import { describe, expect, it } from '@jest/globals';
import { shouldSyncProviderRepositories } from './types';
import type { PlatformRepository } from '@kilocode/db/schema-types';

const repositories: PlatformRepository[] = [
  { id: 1, name: 'cloud', full_name: 'kilocode/cloud', private: true },
  { id: 2, name: 'extension', full_name: 'kilocode/extension', private: false },
];

describe('shouldSyncProviderRepositories', () => {
  it('answers from a non-empty snapshot without a provider round-trip', () => {
    expect(
      shouldSyncProviderRepositories({
        forceRefresh: false,
        cachedRepositories: repositories,
        repositoriesSyncedAt: '2024-01-01T00:00:00Z',
      })
    ).toBe(false);
  });

  it('answers from a synced empty snapshot (the connected-empty state)', () => {
    expect(
      shouldSyncProviderRepositories({
        forceRefresh: false,
        cachedRepositories: [],
        repositoriesSyncedAt: '2024-01-01T00:00:00Z',
      })
    ).toBe(false);
  });

  it('syncs an integration that has never synced', () => {
    expect(
      shouldSyncProviderRepositories({
        forceRefresh: false,
        cachedRepositories: null,
        repositoriesSyncedAt: null,
      })
    ).toBe(true);
    expect(
      shouldSyncProviderRepositories({
        forceRefresh: false,
        cachedRepositories: [],
        repositoriesSyncedAt: null,
      })
    ).toBe(true);
  });

  it('syncs whenever the caller forces a refresh', () => {
    expect(
      shouldSyncProviderRepositories({
        forceRefresh: true,
        cachedRepositories: repositories,
        repositoriesSyncedAt: '2024-01-01T00:00:00Z',
      })
    ).toBe(true);
    expect(
      shouldSyncProviderRepositories({
        forceRefresh: true,
        cachedRepositories: [],
        repositoriesSyncedAt: '2024-01-01T00:00:00Z',
      })
    ).toBe(true);
  });
});
