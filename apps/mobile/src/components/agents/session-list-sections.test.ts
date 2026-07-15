import { describe, expect, it } from 'vitest';

import { buildSessionSections } from './session-list-sections';
import { type ActiveSession, type StoredSession } from '@/lib/hooks/use-agent-sessions';

function stored(overrides: { session_id: string } & Partial<StoredSession>): StoredSession {
  const { session_id, ...rest } = overrides;
  return {
    session_id,
    title: 'Stored session',
    cloud_agent_session_id: null,
    parent_session_id: null,
    organization_id: null,
    created_on_platform: 'cli',
    git_url: 'https://github.com/kilo/repo.git',
    git_branch: 'main',
    status: null,
    status_updated_at: null,
    created_at: '2026-07-01 00:00:00+00',
    updated_at: '2026-07-01 00:00:00+00',
    version: 0,
    associatedPr: null,
    ...rest,
  };
}

function active(overrides: { id: string } & Partial<ActiveSession>): ActiveSession {
  const { id, ...rest } = overrides;
  return {
    id,
    title: 'Active session',
    status: 'busy',
    connectionId: 'connection-1',
    ...rest,
  };
}

const ids = (sections: ReturnType<typeof buildSessionSections>) =>
  sections.map(section => ({
    title: section.title,
    ids: section.data.map(item =>
      item.kind === 'stored' ? item.session.session_id : item.session.id
    ),
    kinds: section.data.map(item => item.kind),
  }));

const allStoredIds = (sections: ReturnType<typeof buildSessionSections>) =>
  sections.flatMap(section =>
    section.data.flatMap(item => (item.kind === 'stored' ? [item.session.session_id] : []))
  );

describe('buildSessionSections', () => {
  it('moves live stored and active-only sessions into Active now exactly once', () => {
    const liveStored = stored({ session_id: 'live-stored', created_on_platform: 'cloud-agent' });
    const history = stored({ session_id: 'history' });

    expect(
      ids(
        buildSessionSections({
          activeNow: true,
          activeSessions: [active({ id: 'live-stored' }), active({ id: 'remote-only' })],
          storedGroups: [{ label: 'Today', sessions: [liveStored, history] }],
          platformFilter: [],
          projectFilter: [],
          searchQuery: '',
          organizationId: null,
        })
      )
    ).toEqual([
      { title: 'Active now', ids: ['live-stored', 'remote-only'], kinds: ['stored', 'remote'] },
      { title: 'Today', ids: ['history'], kinds: ['stored'] },
    ]);
  });

  it('preserves current placement when Active now is disabled', () => {
    const liveStored = stored({ session_id: 'live-stored' });

    expect(
      ids(
        buildSessionSections({
          activeNow: false,
          activeSessions: [active({ id: 'live-stored' }), active({ id: 'remote-only' })],
          storedGroups: [{ label: 'Today', sessions: [liveStored] }],
          platformFilter: [],
          projectFilter: [],
          searchQuery: '',
          organizationId: null,
        })
      )
    ).toEqual([
      { title: 'Remote', ids: ['remote-only'], kinds: ['remote'] },
      { title: 'Today', ids: ['live-stored'], kinds: ['stored'] },
    ]);
  });

  it('marks stored items in Active now as live so the row can show the live indicator', () => {
    const liveStored = stored({ session_id: 'live-stored' });

    const sections = buildSessionSections({
      activeNow: true,
      activeSessions: [active({ id: 'live-stored' })],
      storedGroups: [{ label: 'Today', sessions: [liveStored] }],
      platformFilter: [],
      projectFilter: [],
      searchQuery: '',
      organizationId: null,
    });

    const firstSection = sections[0];
    expect(firstSection?.title).toBe('Active now');
    const onlyItem = firstSection?.data[0];
    expect(onlyItem?.kind).toBe('stored');
    if (onlyItem?.kind === 'stored') {
      expect(onlyItem.isLive).toBe(true);
    }
  });

  it('treats active-only sessions as CLI for platform filtering', () => {
    const base = {
      activeNow: true,
      activeSessions: [active({ id: 'remote-only' })],
      storedGroups: [],
      projectFilter: [],
      searchQuery: '',
      organizationId: null,
    };
    expect(ids(buildSessionSections({ ...base, platformFilter: ['cli'] }))).toEqual([
      { title: 'Active now', ids: ['remote-only'], kinds: ['remote'] },
    ]);
    expect(ids(buildSessionSections({ ...base, platformFilter: ['cloud-agent'] }))).toEqual([]);
  });

  it('honors enriched createdOnPlatform on active-only sessions for platform filtering', () => {
    const base = {
      activeNow: true,
      activeSessions: [active({ id: 'cloud-only', createdOnPlatform: 'cloud-agent' })],
      storedGroups: [],
      projectFilter: [],
      searchQuery: '',
      organizationId: null,
    };
    expect(ids(buildSessionSections({ ...base, platformFilter: ['cloud-agent'] }))).toEqual([
      { title: 'Active now', ids: ['cloud-only'], kinds: ['remote'] },
    ]);
    expect(ids(buildSessionSections({ ...base, platformFilter: ['cli'] }))).toEqual([]);
  });

  it('applies search and project filters to active-only sessions', () => {
    expect(
      ids(
        buildSessionSections({
          activeNow: true,
          activeSessions: [
            active({
              id: 'match',
              title: 'Fix checkout',
              gitUrl: 'https://github.com/kilo/repo.git',
            }),
          ],
          storedGroups: [],
          platformFilter: [],
          projectFilter: ['https://github.com/kilo/repo.git'],
          searchQuery: 'checkout',
          organizationId: null,
        })
      )
    ).toEqual([{ title: 'Active now', ids: ['match'], kinds: ['remote'] }]);
  });

  it('filters out active-only sessions whose project does not match the project filter', () => {
    expect(
      ids(
        buildSessionSections({
          activeNow: true,
          activeSessions: [active({ id: 'other', gitUrl: 'https://github.com/kilo/other.git' })],
          storedGroups: [],
          platformFilter: [],
          projectFilter: ['https://github.com/kilo/repo.git'],
          searchQuery: '',
          organizationId: null,
        })
      )
    ).toEqual([]);
  });

  it('omits active-only sessions when organization scope cannot be verified', () => {
    expect(
      buildSessionSections({
        activeNow: true,
        activeSessions: [active({ id: 'remote-only' })],
        storedGroups: [],
        platformFilter: [],
        projectFilter: [],
        searchQuery: '',
        organizationId: 'org-1',
      })
    ).toEqual([]);
  });

  it('keeps organization-scoped stored records while omitting unverifiable active-only records', () => {
    const orgStored = stored({ session_id: 'org-stored', organization_id: 'org-1' });

    const sections = buildSessionSections({
      activeNow: true,
      activeSessions: [
        active({ id: 'remote-only' }),
        active({ id: 'remote-org', organizationId: 'org-1' }),
      ],
      storedGroups: [{ label: 'Today', sessions: [orgStored] }],
      platformFilter: [],
      projectFilter: [],
      searchQuery: '',
      organizationId: 'org-1',
    });

    expect(ids(sections)).toEqual([
      { title: 'Active now', ids: ['remote-org'], kinds: ['remote'] },
      { title: 'Today', ids: ['org-stored'], kinds: ['stored'] },
    ]);
  });

  it('omits an empty Active now section and returns stored sessions after presence ends', () => {
    const session = stored({ session_id: 'formerly-live' });
    expect(
      ids(
        buildSessionSections({
          activeNow: true,
          activeSessions: [],
          storedGroups: [{ label: 'Today', sessions: [session] }],
          platformFilter: [],
          projectFilter: [],
          searchQuery: '',
          organizationId: null,
        })
      )
    ).toEqual([{ title: 'Today', ids: ['formerly-live'], kinds: ['stored'] }]);
  });

  it('deduplicates stored sessions that repeat across groups', () => {
    const dup = stored({ session_id: 'dup' });
    const other = stored({ session_id: 'other' });
    const sections = buildSessionSections({
      activeNow: false,
      activeSessions: [],
      storedGroups: [
        { label: 'Today', sessions: [dup] },
        { label: 'Older', sessions: [dup, other] },
      ],
      platformFilter: [],
      projectFilter: [],
      searchQuery: '',
      organizationId: null,
    });

    const allIds = allStoredIds(sections);
    expect(allIds).toEqual(['dup', 'other']);
  });

  it('keeps a previously-live stored session in its date section once presence ends, even when activeNow is on', () => {
    const storedSession = stored({ session_id: 'returned' });
    const sections = buildSessionSections({
      activeNow: true,
      activeSessions: [],
      storedGroups: [{ label: 'Today', sessions: [storedSession] }],
      platformFilter: [],
      projectFilter: [],
      searchQuery: '',
      organizationId: null,
    });

    expect(ids(sections)).toEqual([{ title: 'Today', ids: ['returned'], kinds: ['stored'] }]);
  });
});
