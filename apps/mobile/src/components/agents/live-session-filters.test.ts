import { describe, expect, it } from 'vitest';

import {
  buildLiveFilterOptions,
  filterLiveSessions,
  liveSessionPlatformBucket,
} from './live-session-filters';

const CLOUD = {
  id: 'cloud',
  gitUrl: 'https://github.com/kilo/cloud.git',
  createdOnPlatform: 'cloud-agent-web',
};
const CLI = { id: 'cli', gitUrl: 'git@github.com:kilo/app.git', createdOnPlatform: 'cli' };
const VSCODE = {
  id: 'vscode',
  gitUrl: 'https://github.com/kilo/cloud.git',
  createdOnPlatform: 'vscode',
};
const BARE = { id: 'bare', gitUrl: null, createdOnPlatform: 'unknown' };

describe('liveSessionPlatformBucket', () => {
  it('folds platform variants into the filter bucket', () => {
    expect(liveSessionPlatformBucket('cloud-agent-web')).toBe('cloud-agent');
    expect(liveSessionPlatformBucket('agent-manager')).toBe('extension');
    expect(liveSessionPlatformBucket('cli')).toBe('cli');
  });

  it('buckets an unlisted platform as other and an unknown origin as null', () => {
    expect(liveSessionPlatformBucket('jetbrains')).toBe('other');
    expect(liveSessionPlatformBucket('unknown')).toBeNull();
    expect(liveSessionPlatformBucket(undefined)).toBeNull();
  });
});

describe('buildLiveFilterOptions', () => {
  it('offers each repository once, sorted, and skips rows without one', () => {
    const { projectOptions } = buildLiveFilterOptions([CLOUD, VSCODE, CLI, BARE]);

    expect(projectOptions).toEqual([
      { gitUrl: 'git@github.com:kilo/app.git', displayName: 'kilo/app' },
      { gitUrl: 'https://github.com/kilo/cloud.git', displayName: 'kilo/cloud' },
    ]);
  });

  it('offers only the platform buckets that are live, in canonical order', () => {
    expect(buildLiveFilterOptions([CLI, VSCODE, CLOUD, BARE]).platformOptions).toEqual([
      'cloud-agent',
      'extension',
      'cli',
    ]);
  });

  it('offers nothing for an empty live list', () => {
    expect(buildLiveFilterOptions([])).toEqual({ projectOptions: [], platformOptions: [] });
  });
});

describe('filterLiveSessions', () => {
  const sessions = [CLOUD, CLI, VSCODE, BARE];

  it('returns the list untouched when no filter is applied', () => {
    expect(filterLiveSessions(sessions, [], [])).toBe(sessions);
  });

  it('keeps only the selected repository', () => {
    expect(
      filterLiveSessions(sessions, [], ['https://github.com/kilo/cloud.git']).map(s => s.id)
    ).toEqual(['cloud', 'vscode']);
  });

  it('matches a platform bucket across its variants', () => {
    expect(filterLiveSessions(sessions, ['cloud-agent'], []).map(s => s.id)).toEqual(['cloud']);
    expect(filterLiveSessions(sessions, ['extension'], []).map(s => s.id)).toEqual(['vscode']);
  });

  it('combines both dimensions with AND', () => {
    expect(
      filterLiveSessions(sessions, ['cli'], ['https://github.com/kilo/cloud.git'])
    ).toHaveLength(0);
    expect(
      filterLiveSessions(sessions, ['cli'], ['git@github.com:kilo/app.git']).map(s => s.id)
    ).toEqual(['cli']);
  });

  it('never claims a row with an unknown origin or no repository', () => {
    expect(filterLiveSessions(sessions, ['other'], [])).toHaveLength(0);
    expect(filterLiveSessions([BARE], [], ['https://github.com/kilo/cloud.git'])).toHaveLength(0);
  });
});
