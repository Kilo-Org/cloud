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
  },
  {
    id: 'ses_web',
    title: 'Cloud web session',
    gitUrl: 'https://github.com/acme/widgets',
    createdOnPlatform: 'cloud-agent-web',
  },
  { id: 'ses_unattributed', title: 'Legacy CLI session' },
];

const noQuery = { platformFilter: [], projectFilter: [], searchQuery: '' };

describe('platformFilterValues', () => {
  it('expands a filter value to every stored platform it covers', () => {
    expect(platformFilterValues(['cloud-agent'])).toEqual(['cloud-agent', 'cloud-agent-web']);
    expect(platformFilterValues(['extension'])).toEqual(['vscode', 'agent-manager']);
    expect(platformFilterValues(['cli', 'slack'])).toEqual(['cli', 'slack']);
  });
});

describe('matchesLivePlatformFilter', () => {
  it('claims a row by either reported origin', () => {
    const selected = new Set(['cli']);
    expect(matchesLivePlatformFilter(liveSessions[0], selected)).toBe(true);
    expect(matchesLivePlatformFilter({ id: 'ses_x', title: 'x', platform: 'cli' }, selected)).toBe(
      true
    );
    expect(matchesLivePlatformFilter(liveSessions[1], selected)).toBe(false);
  });

  it('claims a row with no reported origin by no selection', () => {
    expect(matchesLivePlatformFilter(liveSessions[2], new Set(['cloud-agent']))).toBe(false);
    expect(matchesLivePlatformFilter(liveSessions[2], new Set())).toBe(true);
  });
});

describe('filterLiveSidebarSessions', () => {
  it('returns every row when nothing is selected', () => {
    expect(filterLiveSidebarSessions(liveSessions, noQuery)).toEqual(liveSessions);
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

  it('combines origin, repository, and text with AND', () => {
    expect(
      filterLiveSidebarSessions(liveSessions, {
        platformFilter: ['cloud-agent'],
        projectFilter: ['git@github.com:acme/widgets.git'],
        searchQuery: 'cloud',
      }).map(row => row.id)
    ).toEqual(['ses_web']);

    expect(
      filterLiveSidebarSessions(liveSessions, {
        platformFilter: ['cloud-agent'],
        projectFilter: [],
        searchQuery: 'REMOTE',
      })
    ).toEqual([]);
  });

  it('matches the search against the title, id, and repository', () => {
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'widgets' })
    ).toHaveLength(2);
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'ses_remote' }).map(
        row => row.id
      )
    ).toEqual(['ses_remote']);
  });
});
