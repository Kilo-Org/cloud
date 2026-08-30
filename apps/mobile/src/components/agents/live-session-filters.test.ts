import { describe, expect, it } from 'vitest';

import {
  buildLiveFilterOptions,
  filterLiveSessions,
  liveSessionPlatformBucket,
  type LiveSessionQuery,
} from './live-session-filters';

const CLOUD = {
  id: 'cloud',
  title: 'Fix the login redirect',
  gitUrl: 'https://github.com/kilo/cloud.git',
  createdOnPlatform: 'cloud-agent-web',
};
const CLI = {
  id: 'cli',
  title: 'Bump deps',
  gitUrl: 'git@github.com:kilo/app.git',
  createdOnPlatform: 'cli',
};
const VSCODE = {
  id: 'vscode',
  title: 'Rename the module',
  gitUrl: 'https://github.com/kilo/cloud.git',
  createdOnPlatform: 'vscode',
};
const BARE = { id: 'bare', title: '', gitUrl: null, createdOnPlatform: 'unknown' };

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

const query = (over: Partial<LiveSessionQuery> = {}): LiveSessionQuery => ({
  platformFilter: [],
  projectFilter: [],
  searchQuery: '',
  ...over,
});

describe('filterLiveSessions', () => {
  const sessions = [CLOUD, CLI, VSCODE, BARE];

  it('returns the list untouched when nothing narrows it', () => {
    expect(filterLiveSessions(sessions, query())).toBe(sessions);
  });

  it('keeps only the selected repository', () => {
    expect(
      filterLiveSessions(
        sessions,
        query({ projectFilter: ['https://github.com/kilo/cloud.git'] })
      ).map(s => s.id)
    ).toEqual(['cloud', 'vscode']);
  });

  it('matches a platform bucket across its variants', () => {
    expect(
      filterLiveSessions(sessions, query({ platformFilter: ['cloud-agent'] })).map(s => s.id)
    ).toEqual(['cloud']);
    expect(
      filterLiveSessions(sessions, query({ platformFilter: ['extension'] })).map(s => s.id)
    ).toEqual(['vscode']);
  });

  it('combines every dimension with AND', () => {
    expect(
      filterLiveSessions(
        sessions,
        query({ platformFilter: ['cli'], projectFilter: ['https://github.com/kilo/cloud.git'] })
      )
    ).toHaveLength(0);
    expect(
      filterLiveSessions(
        sessions,
        query({ platformFilter: ['cli'], projectFilter: ['git@github.com:kilo/app.git'] })
      ).map(s => s.id)
    ).toEqual(['cli']);
  });

  it('searches the title case-insensitively', () => {
    expect(
      filterLiveSessions(sessions, query({ searchQuery: '  FIX the ' })).map(s => s.id)
    ).toEqual(['cloud']);
  });

  it('searches the repository name too', () => {
    expect(filterLiveSessions(sessions, query({ searchQuery: 'kilo/app' })).map(s => s.id)).toEqual(
      ['cli']
    );
  });

  it('treats a whitespace-only query as no search', () => {
    expect(filterLiveSessions(sessions, query({ searchQuery: '   ' }))).toBe(sessions);
  });

  it('never claims a row with an unknown origin or no repository', () => {
    expect(filterLiveSessions(sessions, query({ platformFilter: ['other'] }))).toHaveLength(0);
    expect(
      filterLiveSessions([BARE], query({ projectFilter: ['https://github.com/kilo/cloud.git'] }))
    ).toHaveLength(0);
  });
});
