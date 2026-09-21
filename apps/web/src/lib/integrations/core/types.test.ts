import { describe, expect, it } from '@jest/globals';
import { findRepositoryIdByFullName, shouldSyncProviderRepositories } from './types';
import type { PlatformRepository } from '@kilocode/db/schema-types';

const repositories: PlatformRepository[] = [
  { id: 1, name: 'cloud', full_name: 'kilocode/cloud', private: true },
  { id: 2, name: 'extension', full_name: 'kilocode/extension', private: false },
];

describe('findRepositoryIdByFullName', () => {
  it('returns the matching repository id', () => {
    expect(findRepositoryIdByFullName(repositories, 'kilocode/cloud')).toBe(1);
  });

  it('matches case-insensitively', () => {
    expect(findRepositoryIdByFullName(repositories, 'KiloCode/Cloud')).toBe(1);
  });

  it('returns null when there is no match', () => {
    expect(findRepositoryIdByFullName(repositories, 'kilocode/missing')).toBeNull();
  });

  it('returns null for a null repository list', () => {
    expect(findRepositoryIdByFullName(null, 'kilocode/cloud')).toBeNull();
  });

  it('returns null for an empty repository list', () => {
    expect(findRepositoryIdByFullName([], 'kilocode/cloud')).toBeNull();
  });
});

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
