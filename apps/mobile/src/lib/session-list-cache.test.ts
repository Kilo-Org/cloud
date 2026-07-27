import { describe, expect, it } from 'vitest';

import {
  mapStoredSessions,
  removeStoredSession,
  type SessionsListData,
  type SessionsListPage,
} from '@/lib/session-list-cache';

function makeSession(
  overrides: Partial<SessionsListPage['cliSessions'][number]> = {}
): SessionsListPage['cliSessions'][number] {
  return {
    session_id: 's1',
    title: 'Untitled',
    cloud_agent_session_id: null,
    parent_session_id: null,
    organization_id: null,
    created_on_platform: 'cli',
    git_url: null,
    git_branch: null,
    status: null,
    status_updated_at: null,
    created_at: '2026-07-01 00:00:00+00',
    updated_at: '2026-07-01 00:00:00+00',
    version: 0,
    associatedPr: null,
    total_cost_microdollars: null,
    ...overrides,
  };
}

function makePage(overrides: Partial<SessionsListPage> = {}): SessionsListPage {
  return { cliSessions: [], nextCursor: null, ...overrides };
}

function firstPage(data: SessionsListData): SessionsListPage {
  const page = data.pages[0];
  if (!page) {
    throw new Error('expected at least one page');
  }
  return page;
}

describe('mapStoredSessions', () => {
  it('updates only the matching session and leaves others untouched', () => {
    const other = makeSession({ session_id: 's2', title: 'Other' });
    const target = makeSession({ session_id: 's1', title: 'Old title' });
    const data: SessionsListData = {
      pages: [makePage({ cliSessions: [target, other] })],
      pageParams: [undefined],
    };

    const result = mapStoredSessions(data, 's1', session => ({ ...session, title: 'New title' }));

    const page = firstPage(result);
    expect(page.cliSessions.find(s => s.session_id === 's1')?.title).toBe('New title');
    expect(page.cliSessions.find(s => s.session_id === 's2')?.title).toBe('Other');
  });

  it('passes through unchanged when no session matches', () => {
    const session = makeSession({ session_id: 's1', title: 'Original' });
    const data: SessionsListData = {
      pages: [makePage({ cliSessions: [session] })],
      pageParams: [undefined],
    };

    const result = mapStoredSessions(data, 'missing', s => ({ ...s, title: 'Changed' }));

    expect(firstPage(result).cliSessions[0]?.title).toBe('Original');
  });

  it('passes through unchanged on an empty page list', () => {
    const data: SessionsListData = { pages: [], pageParams: [] };

    const result = mapStoredSessions(data, 's1', s => ({ ...s, title: 'Changed' }));

    expect(result.pages).toEqual([]);
  });

  it('preserves the infinite-query page shape (pageParams, nextCursor, page count)', () => {
    const session = makeSession({ session_id: 's1', title: 'Original' });
    const data: SessionsListData = {
      pages: [makePage({ cliSessions: [session], nextCursor: '2026-07-01 00:00:00+00' })],
      pageParams: [undefined],
    };

    const result = mapStoredSessions(data, 's1', s => ({ ...s, title: 'Changed' }));

    expect(result.pageParams).toBe(data.pageParams);
    expect(result.pages).toHaveLength(1);
    expect(firstPage(result).nextCursor).toBe('2026-07-01 00:00:00+00');
  });
});

describe('removeStoredSession', () => {
  it('removes only the target session, leaving others in place', () => {
    const target = makeSession({ session_id: 's1' });
    const other = makeSession({ session_id: 's2' });
    const data: SessionsListData = {
      pages: [makePage({ cliSessions: [target, other] })],
      pageParams: [undefined],
    };

    const result = removeStoredSession(data, 's1');

    expect(firstPage(result).cliSessions.map(s => s.session_id)).toEqual(['s2']);
  });

  it('passes through unchanged when no session matches', () => {
    const session = makeSession({ session_id: 's1' });
    const data: SessionsListData = {
      pages: [makePage({ cliSessions: [session] })],
      pageParams: [undefined],
    };

    const result = removeStoredSession(data, 'missing');

    expect(firstPage(result).cliSessions).toHaveLength(1);
  });

  it('passes through unchanged on an empty page list', () => {
    const data: SessionsListData = { pages: [], pageParams: [] };

    const result = removeStoredSession(data, 's1');

    expect(result.pages).toEqual([]);
  });

  it('preserves the infinite-query page shape (pageParams, nextCursor, page count)', () => {
    const target = makeSession({ session_id: 's1' });
    const other = makeSession({ session_id: 's2' });
    const data: SessionsListData = {
      pages: [makePage({ cliSessions: [target, other], nextCursor: 'abc' })],
      pageParams: [undefined],
    };

    const result = removeStoredSession(data, 's1');

    expect(result.pageParams).toBe(data.pageParams);
    expect(result.pages).toHaveLength(1);
    expect(firstPage(result).nextCursor).toBe('abc');
  });
});
