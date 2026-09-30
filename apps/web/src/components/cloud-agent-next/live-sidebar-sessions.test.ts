import {
  filterLiveSidebarSessions,
  matchesLivePlatformFilter,
  platformFilterValues,
} from './live-sidebar-sessions';

const liveSessions = [
  {
    id: 'ses_remote',
    title: 'Remote CLI session',
    gitUrl: 'https://github.com/acme/Widgets.git',
    createdOnPlatform: 'cli',
    organizationId: null,
  },
  {
    id: 'ses_web',
    title: 'Cloud web session',
    gitUrl: 'https://github.com/acme/widgets',
    createdOnPlatform: 'cloud-agent-web',
    organizationId: null,
  },
  {
    id: 'ses_org',
    title: 'Org CLI session',
    createdOnPlatform: 'cli',
    organizationId: 'org_1',
  },
  { id: 'ses_other', title: 'Custom client session', createdOnPlatform: 'my-tool' },
  { id: 'ses_unattributed', title: 'Legacy CLI session' },
];

const noQuery = {
  organizationId: null,
  platformFilter: [],
  projectFilter: [],
  searchQuery: '',
};

describe('platformFilterValues', () => {
  it('expands a filter value to every stored platform it covers', () => {
    expect(platformFilterValues(['cloud-agent'])).toEqual(['cloud-agent', 'cloud-agent-web']);
    expect(platformFilterValues(['extension'])).toEqual(['vscode', 'agent-manager']);
    expect(platformFilterValues(['cli', 'slack'])).toEqual(['cli', 'slack']);
  });
});

describe('matchesLivePlatformFilter', () => {
  it('claims a row by its stored origin', () => {
    expect(matchesLivePlatformFilter(liveSessions[0], ['cli'])).toBe(true);
    expect(matchesLivePlatformFilter(liveSessions[1], ['cloud-agent'])).toBe(true);
    expect(matchesLivePlatformFilter(liveSessions[1], ['cli'])).toBe(false);
  });

  it('claims an origin outside the platform catalogue by the other bucket', () => {
    expect(matchesLivePlatformFilter(liveSessions[3], ['other'])).toBe(true);
    expect(matchesLivePlatformFilter(liveSessions[3], ['cli'])).toBe(false);
  });

  it('claims a row with no reported origin by no selection', () => {
    expect(matchesLivePlatformFilter(liveSessions[4], ['cloud-agent'])).toBe(false);
    expect(matchesLivePlatformFilter(liveSessions[4], ['other'])).toBe(false);
    expect(matchesLivePlatformFilter(liveSessions[4], [])).toBe(true);
  });

  it('never claims a row by the client the connection runs in', () => {
    const darwinRow = { id: 'ses_darwin', title: 'macOS CLI', platform: 'darwin' };

    expect(matchesLivePlatformFilter(darwinRow, ['cli'])).toBe(false);
    expect(matchesLivePlatformFilter(darwinRow, ['other'])).toBe(false);
  });
});

describe('filterLiveSidebarSessions', () => {
  it('returns every row in scope when nothing is selected', () => {
    expect(filterLiveSidebarSessions(liveSessions, noQuery).map(row => row.id)).toEqual([
      'ses_remote',
      'ses_web',
      'ses_other',
      'ses_unattributed',
    ]);
  });

  it('keeps a row another scope owns out of the sidebar', () => {
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, organizationId: 'org_1' }).map(
        row => row.id
      )
    ).toEqual(['ses_org']);
  });

  it('hides remote rows while only cloud is selected', () => {
    const rows = filterLiveSidebarSessions(liveSessions, {
      ...noQuery,
      platformFilter: ['cloud-agent'],
    });

    expect(rows.map(row => row.id)).toEqual(['ses_web']);
  });

  it('keeps remote rows while the cli platform is selected', () => {
    const rows = filterLiveSidebarSessions(liveSessions, {
      ...noQuery,
      platformFilter: ['cli'],
    });

    expect(rows.map(row => row.id)).toEqual(['ses_remote']);
  });

  it('combines scope, origin, repository, and text with AND', () => {
    expect(
      filterLiveSidebarSessions(liveSessions, {
        ...noQuery,
        platformFilter: ['cloud-agent'],
        projectFilter: ['git@github.com:acme/widgets.git'],
        searchQuery: 'cloud',
      }).map(row => row.id)
    ).toEqual(['ses_web']);

    expect(
      filterLiveSidebarSessions(liveSessions, {
        ...noQuery,
        platformFilter: ['cloud-agent'],
        projectFilter: [],
        searchQuery: 'REMOTE',
      })
    ).toEqual([]);
  });

  it('matches the search against the title and the id', () => {
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'legacy' }).map(
        row => row.id
      )
    ).toEqual(['ses_unattributed']);
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'ses_remote' }).map(
        row => row.id
      )
    ).toEqual(['ses_remote']);
  });

  it('does not search the repository, which the stored list does not search either', () => {
    expect(filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'widgets' })).toEqual(
      []
    );
  });
});
