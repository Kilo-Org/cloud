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
    gitBranch: 'fix/remote-row',
    createdOnPlatform: 'cli',
  },
  {
    id: 'ses_web',
    title: 'Cloud web session',
    gitUrl: 'https://github.com/acme/widgets',
    gitBranch: 'main',
    createdOnPlatform: 'cloud-agent-web',
  },
  { id: 'ses_other', title: 'Custom client session', createdOnPlatform: 'my-tool' },
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
  it('claims a row by its stored origin', () => {
    expect(matchesLivePlatformFilter(liveSessions[0], ['cli'])).toBe(true);
    expect(matchesLivePlatformFilter(liveSessions[1], ['cloud-agent'])).toBe(true);
    expect(matchesLivePlatformFilter(liveSessions[1], ['cli'])).toBe(false);
  });

  it('claims an origin outside the platform catalogue by the other bucket', () => {
    expect(matchesLivePlatformFilter(liveSessions[2], ['other'])).toBe(true);
    expect(matchesLivePlatformFilter(liveSessions[2], ['cli'])).toBe(false);
  });

  it('claims a row with no reported origin by no selection', () => {
    expect(matchesLivePlatformFilter(liveSessions[3], ['cloud-agent'])).toBe(false);
    expect(matchesLivePlatformFilter(liveSessions[3], ['other'])).toBe(false);
    expect(matchesLivePlatformFilter(liveSessions[3], [])).toBe(true);
  });

  it('never claims a row by the client the connection runs in', () => {
    const darwinRow = { id: 'ses_darwin', title: 'macOS CLI', platform: 'darwin' };

    expect(matchesLivePlatformFilter(darwinRow, ['cli'])).toBe(false);
    expect(matchesLivePlatformFilter(darwinRow, ['other'])).toBe(false);
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

  it('normalizes the project filter and the row repository before comparing', () => {
    // The stored row gives `https://github.com/acme/Widgets.git` for an option
    // and the live row reports the scp form, or the other way round.
    expect(
      filterLiveSidebarSessions(liveSessions, {
        ...noQuery,
        projectFilter: ['git@github.com:acme/widgets.git'],
      }).map(row => row.id)
    ).toEqual(['ses_remote', 'ses_web']);
    expect(
      filterLiveSidebarSessions(liveSessions, {
        ...noQuery,
        projectFilter: ['https://github.com/acme/widgets'],
      }).map(row => row.id)
    ).toEqual(['ses_remote', 'ses_web']);
    expect(
      filterLiveSidebarSessions(liveSessions, {
        ...noQuery,
        projectFilter: ['https://github.com/acme/other'],
      })
    ).toEqual([]);
  });

  it('matches the search against the title, the id, and the repository', () => {
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
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'widgets' }).map(
        row => row.id
      )
    ).toEqual(['ses_remote', 'ses_web']);
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'acme/widgets' }).map(
        row => row.id
      )
    ).toEqual(['ses_remote', 'ses_web']);
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: '#ses_remote' }).map(
        row => row.id
      )
    ).toEqual(['ses_remote']);
  });

  it('matches the search against the branch', () => {
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'fix/remote' }).map(
        row => row.id
      )
    ).toEqual(['ses_remote']);
    expect(
      filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: 'main' }).map(
        row => row.id
      )
    ).toEqual(['ses_web']);
  });

  it('matches nothing for a query that reduces to an empty needle', () => {
    expect(filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: '#' })).toEqual([]);
    expect(filterLiveSidebarSessions(liveSessions, { ...noQuery, searchQuery: '   ' })).toEqual([]);
  });
});

describe('filterLiveSidebarSessions organization scope', () => {
  const scopedSessions = [
    { id: 'ses_org', title: 'Org session', organizationId: 'org-1' },
    { id: 'ses_other_org', title: 'Other org session', organizationId: 'org-2' },
    { id: 'ses_personal', title: 'Personal session', organizationId: null },
    { id: 'ses_new', title: 'Not ingested yet' },
  ];

  it('keeps every scope when the sidebar has no organization', () => {
    expect(filterLiveSidebarSessions(scopedSessions, noQuery)).toEqual(scopedSessions);
  });

  it('keeps only the personal rows in the personal view', () => {
    const rows = filterLiveSidebarSessions(scopedSessions, {
      ...noQuery,
      organizationId: null,
    });

    expect(rows.map(row => row.id)).toEqual(['ses_personal']);
  });

  it('drops organization and not-yet-attributed rows from the personal view', () => {
    const rows = filterLiveSidebarSessions(scopedSessions, {
      ...noQuery,
      organizationId: null,
    });

    expect(rows.map(row => row.id)).not.toContain('ses_org');
    expect(rows.map(row => row.id)).not.toContain('ses_other_org');
    expect(rows.map(row => row.id)).not.toContain('ses_new');
  });

  it('keeps only the rows owned by the scoped organization', () => {
    const rows = filterLiveSidebarSessions(scopedSessions, {
      ...noQuery,
      organizationId: 'org-1',
    });

    expect(rows.map(row => row.id)).toEqual(['ses_org']);
  });

  it('drops personal and not-yet-attributed rows from an organization view', () => {
    const rows = filterLiveSidebarSessions(scopedSessions, {
      ...noQuery,
      organizationId: 'org-1',
    });

    expect(rows.map(row => row.id)).not.toContain('ses_personal');
    expect(rows.map(row => row.id)).not.toContain('ses_new');
  });

  it('combines the organization scope with the platform and search filters', () => {
    const rows = filterLiveSidebarSessions(
      [
        ...scopedSessions,
        {
          id: 'ses_org_cloud',
          title: 'Cloud session',
          organizationId: 'org-1',
          createdOnPlatform: 'cloud-agent',
        },
      ],
      {
        platformFilter: ['cloud-agent'],
        projectFilter: [],
        searchQuery: '',
        organizationId: 'org-1',
      }
    );

    expect(rows.map(row => row.id)).toEqual(['ses_org_cloud']);
  });
});
