import type { MessageDeliveryState, UserWebSessionEventData } from '@kilocode/cloud-agent-sdk';
import React, { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type * as DropdownMenuComponents from '@/components/ui/dropdown-menu';
import type * as DropdownMenuPrimitives from '@radix-ui/react-dropdown-menu';
import { ChatSidebar } from '../ChatSidebar';
import { SessionPrIndicator } from '../SessionPrIndicator';
import type { DbSessionV2 } from '../store/db-session-atoms';
import type { StoredSession } from '../types';
import {
  createSidebarQueryReconciler,
  dbSessionToStoredSession,
  dbSessionMatchesSearch,
  deriveForegroundSessionStatus,
  eventRowMatchesSidebarFilters,
  eventRowToDbSession,
  getSidebarWorktreeActivity,
  getSidebarWorktreeLabel,
  getSidebarWorktreePrSession,
  groupSidebarSessions,
  groupSidebarSessionsByDate,
  mergeWorktreeChatSessions,
  patchSidebarWorktreeSessionStatus,
  removeSidebarDbSession,
  sessionCacheKey,
  SIDEBAR_RECONCILE_DELAY_MS,
  upsertSidebarDbSession,
  type SidebarWorktreeDetails,
} from './useSidebarSessions';

Object.assign(globalThis, { React });

let mockRenderOpenMenus = false;

jest.mock('next/navigation', () => ({
  usePathname: () => '/cloud/chat',
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/components/ui/dropdown-menu', () => {
  const actual = jest.requireActual<typeof DropdownMenuComponents>('@/components/ui/dropdown-menu');
  const primitives = jest.requireActual<typeof DropdownMenuPrimitives>(
    '@radix-ui/react-dropdown-menu'
  );
  const { createElement } = jest.requireActual<typeof React>('react');

  return {
    ...actual,
    DropdownMenu: (props: ComponentProps<typeof actual.DropdownMenu>) =>
      createElement(actual.DropdownMenu, {
        ...props,
        open: mockRenderOpenMenus ? true : props.open,
      }),
    DropdownMenuContent: (props: ComponentProps<typeof actual.DropdownMenuContent>) =>
      createElement(primitives.Content, props),
    DropdownMenuItem: jest.fn(actual.DropdownMenuItem),
  };
});

jest.mock('../SessionPrIndicator', () => {
  const actual = jest.requireActual<{ SessionPrIndicator: typeof SessionPrIndicator }>(
    '../SessionPrIndicator'
  );
  return { ...actual, SessionPrIndicator: jest.fn(actual.SessionPrIndicator) };
});

const associatedPr = {
  url: 'https://github.com/kilo/repo/pull/42',
  number: 42,
  state: 'open',
  title: 'Worktree changes',
  headSha: 'abc123',
  lastSyncedAt: '2026-01-01T00:00:00.000Z',
  reviewDecision: null,
  reviewDecisionPending: false,
  platform: 'github',
} satisfies NonNullable<StoredSession['associatedPr']>;

function makeDbSession(sessionId: string, updatedAt: string): DbSessionV2 {
  return {
    session_id: sessionId,
    title: sessionId,
    cloud_agent_session_id: null,
    created_on_platform: 'web',
    organization_id: null,
    git_url: 'https://github.com/kilo/repo',
    git_branch: 'main',
    parent_session_id: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date(updatedAt),
    version: 2,
    status: 'idle',
    status_updated_at: null,
  };
}

function makeStoredSession(
  sessionId: string,
  updatedAt: string,
  overrides: Partial<StoredSession> = {}
): StoredSession {
  return { ...dbSessionToStoredSession(makeDbSession(sessionId, updatedAt)), ...overrides };
}

type ForegroundSessionStatusInput = Parameters<typeof deriveForegroundSessionStatus>[0];

function makeForegroundSessionStatusInput(
  overrides: Partial<ForegroundSessionStatusInput> = {}
): ForegroundSessionStatusInput {
  return {
    currentSessionId: 'ses_foreground',
    organizationId: null,
    activeSessionType: 'cloud-agent',
    fetchedSessionData: { kiloSessionId: 'ses_foreground', organizationId: null },
    activity: { type: 'idle' },
    isStreaming: false,
    activeQuestion: null,
    activePermission: null,
    cloudStatus: null,
    pendingMessages: new Map(),
    ...overrides,
  };
}

function makeEventRow(overrides?: Partial<UserWebSessionEventData<'session.created'>['session']>) {
  return {
    source: 'v2',
    sessionId: 'ses_root',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    title: 'Root',
    createdOnPlatform: 'web',
    organizationId: null,
    gitUrl: 'https://github.com/kilo/repo',
    gitBranch: 'main',
    parentSessionId: null,
    status: 'idle',
    statusUpdatedAt: null,
    ...overrides,
  } satisfies UserWebSessionEventData<'session.created'>['session'];
}

describe('useSidebarSessions live update helpers', () => {
  it('preserves updated_at descending order when patching a visible row', () => {
    const newest = makeDbSession('ses_newest', '2026-01-03T00:00:00.000Z');
    const middle = makeDbSession('ses_middle', '2026-01-02T00:00:00.000Z');
    const olderPatch = makeDbSession('ses_older_patch', '2026-01-01T00:00:00.000Z');

    const result = upsertSidebarDbSession([newest, middle], olderPatch);

    expect(result.map(session => session.session_id)).toEqual([
      'ses_newest',
      'ses_middle',
      'ses_older_patch',
    ]);
  });

  it('moves a patched row according to updated_at instead of prepending blindly', () => {
    const newest = makeDbSession('ses_newest', '2026-01-03T00:00:00.000Z');
    const stale = makeDbSession('ses_stale', '2026-01-01T00:00:00.000Z');
    const refreshed = makeDbSession('ses_stale', '2026-01-04T00:00:00.000Z');

    const result = upsertSidebarDbSession([newest, stale], refreshed);

    expect(result.map(session => session.session_id)).toEqual(['ses_stale', 'ses_newest']);
  });

  it('preserves fetched Cloud Agent and PR fields when a live row patches the session', () => {
    const associatedPr = {
      url: 'https://github.com/kilo/repo/pull/42',
      number: 42,
      state: 'open',
      title: 'Realtime sidebar',
      headSha: 'abc123',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      reviewDecision: 'approved' as const,
      reviewDecisionPending: false,
      platform: 'github',
    };
    const cached = {
      ...makeDbSession('ses_cached', '2026-01-01T00:00:00.000Z'),
      cloud_agent_session_id: 'agent_123',
      associatedPr,
    };
    const livePatch = {
      ...makeDbSession('ses_cached', '2026-01-04T00:00:00.000Z'),
      title: 'Updated live title',
      status: 'busy',
    };

    const result = upsertSidebarDbSession([cached], livePatch);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: 'Updated live title',
      status: 'busy',
      cloud_agent_session_id: 'agent_123',
      associatedPr,
    });
  });

  it('preserves an existing group when an older live event omits its worktree', () => {
    const cached = {
      ...makeDbSession('ses_grouped', '2026-01-01T00:00:00.000Z'),
      cloud_agent_worktree_id: 'worktree_existing',
    };
    const olderEvent = eventRowToDbSession(
      makeEventRow({ sessionId: 'ses_grouped', updatedAt: '2026-01-02T00:00:00.000Z' })
    );

    expect(upsertSidebarDbSession([cached], olderEvent)[0]).toMatchObject({
      cloud_agent_worktree_id: 'worktree_existing',
    });
  });

  it('adopts a user-wide event worktree and maps it through the stored sidebar session', () => {
    const cached = makeDbSession('ses_grouped', '2026-01-01T00:00:00.000Z');
    const groupedEvent = eventRowToDbSession(
      makeEventRow({
        sessionId: 'ses_grouped',
        updatedAt: '2026-01-02T00:00:00.000Z',
        worktreeId: 'worktree_added_live',
      })
    );

    const [updated] = upsertSidebarDbSession([cached], groupedEvent);

    expect(dbSessionToStoredSession(updated).worktreeId).toBe('worktree_added_live');
  });

  it('invalidates sidebar equality when only the group identity changes', () => {
    const base = {
      session_id: 'ses_grouped',
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'idle',
      status_updated_at: null,
    };

    expect(sessionCacheKey(base)).not.toBe(
      sessionCacheKey({ ...base, cloud_agent_worktree_id: 'worktree_added_live' })
    );
  });

  it('removes deleted rows immediately from the visible list', () => {
    const result = removeSidebarDbSession(
      [
        makeDbSession('ses_keep', '2026-01-02T00:00:00.000Z'),
        makeDbSession('ses_delete', '2026-01-01T00:00:00.000Z'),
      ],
      'ses_delete'
    );

    expect(result.map(session => session.session_id)).toEqual(['ses_keep']);
  });

  it('excludes child session rows from root-only sidebar filters', () => {
    const result = eventRowMatchesSidebarFilters(
      makeEventRow({ parentSessionId: 'ses_parent' }),
      {}
    );

    expect(result).toBe(false);
  });

  it('treats the platform other filter as unsafe for local-only patching', () => {
    const result = eventRowMatchesSidebarFilters(makeEventRow(), { createdOnPlatform: 'other' });

    expect(result).toBeNull();
  });

  it('preserves associated PR data from fetched sidebar rows', () => {
    const session = {
      ...makeDbSession('ses_with_pr', '2026-01-01T00:00:00.000Z'),
      associatedPr: {
        url: 'https://github.com/kilo/repo/pull/42',
        number: 42,
        state: 'open',
        title: 'Realtime sidebar',
        headSha: 'abc123',
        lastSyncedAt: '2026-01-01T00:00:00.000Z',
        reviewDecision: 'approved' as const,
        reviewDecisionPending: false,
        platform: 'github',
      },
    };

    expect(dbSessionToStoredSession(session).associatedPr).toEqual(session.associatedPr);
  });

  describe('deriveForegroundSessionStatus', () => {
    it('prioritizes permissions over questions, retries, and running work', () => {
      const result = deriveForegroundSessionStatus(
        makeForegroundSessionStatusInput({
          activePermission: { requestId: 'permission' },
          activeQuestion: { requestId: 'question' },
          activity: { type: 'retrying', attempt: 1, message: 'Retrying' },
          isStreaming: true,
          cloudStatus: { type: 'preparing' },
          pendingMessages: new Map<string, MessageDeliveryState>([
            ['message', { status: 'queued' }],
          ]),
        })
      );

      expect(result).toBe('permission');
    });

    it('prioritizes questions over retries and running work', () => {
      const result = deriveForegroundSessionStatus(
        makeForegroundSessionStatusInput({
          activeQuestion: { requestId: 'question' },
          activity: { type: 'retrying', attempt: 1, message: 'Retrying' },
          isStreaming: true,
        })
      );

      expect(result).toBe('question');
    });

    it('prioritizes retries over streaming, cloud preparation, and queued messages', () => {
      const result = deriveForegroundSessionStatus(
        makeForegroundSessionStatusInput({
          activity: { type: 'retrying', attempt: 1, message: 'Retrying' },
          isStreaming: true,
          cloudStatus: { type: 'preparing' },
          pendingMessages: new Map<string, MessageDeliveryState>([
            ['message', { status: 'queued' }],
          ]),
        })
      );

      expect(result).toBe('retry');
    });

    it.each<[string, Partial<ForegroundSessionStatusInput>]>([
      ['busy activity', { activity: { type: 'busy' } }],
      ['streaming', { isStreaming: true }],
      ['cloud preparation', { cloudStatus: { type: 'preparing' } }],
      ['cloud finalization', { cloudStatus: { type: 'finalizing' } }],
      [
        'queued message delivery',
        {
          pendingMessages: new Map<string, MessageDeliveryState>([
            ['message', { status: 'queued' }],
          ]),
        },
      ],
    ])('reports busy for %s', (_label, overrides) => {
      expect(deriveForegroundSessionStatus(makeForegroundSessionStatusInput(overrides))).toBe(
        'busy'
      );
    });

    it('returns idle instead of treating failed queued-message history as active', () => {
      const result = deriveForegroundSessionStatus(
        makeForegroundSessionStatusInput({
          pendingMessages: new Map<string, MessageDeliveryState>([
            [
              'failed-message',
              { status: 'failed', error: 'Delivery failed', reason: 'exhausted', attempts: 3 },
            ],
          ]),
        })
      );

      expect(result).toBe('idle');
    });

    it('derives foreground status within the exact organization scope', () => {
      const result = deriveForegroundSessionStatus(
        makeForegroundSessionStatusInput({
          organizationId: 'organization-current',
          fetchedSessionData: {
            kiloSessionId: 'ses_foreground',
            organizationId: 'organization-current',
          },
          isStreaming: true,
        })
      );

      expect(result).toBe('busy');
    });

    it.each<[string, Partial<ForegroundSessionStatusInput>]>([
      ['a remote session', { activeSessionType: 'remote' }],
      ['a missing current session', { currentSessionId: null }],
      ['missing fetched session data', { fetchedSessionData: null }],
      [
        'a different fetched session',
        { fetchedSessionData: { kiloSessionId: 'ses_different', organizationId: null } },
      ],
      [
        'an organization session on a personal route',
        {
          fetchedSessionData: {
            kiloSessionId: 'ses_foreground',
            organizationId: 'organization-foreign',
          },
        },
      ],
      ['a personal session on an organization route', { organizationId: 'organization-current' }],
      [
        'a different organization',
        {
          organizationId: 'organization-current',
          fetchedSessionData: {
            kiloSessionId: 'ses_foreground',
            organizationId: 'organization-foreign',
          },
        },
      ],
    ])('does not override status for %s', (_label, overrides) => {
      expect(
        deriveForegroundSessionStatus(
          makeForegroundSessionStatusInput({ ...overrides, isStreaming: true })
        )
      ).toBeNull();
    });
  });

  describe('mergeWorktreeChatSessions', () => {
    const worktreeId = 'worktree_shared';

    it('applies newer live titles and statuses while preserving authoritative runtime identity', () => {
      const authoritative = makeStoredSession('ses_existing', '2026-01-01T00:00:00.000Z', {
        worktreeId,
        prompt: 'Original title',
        cloudAgentSessionId: 'workspace_authoritative',
        status: 'active',
        sessionStatus: 'idle',
      });
      const live = makeStoredSession('ses_existing', '2026-01-02T00:00:00.000Z', {
        worktreeId,
        prompt: 'Live title',
        cloudAgentSessionId: null,
        status: 'completed',
        sessionStatus: 'busy',
        sessionStatusUpdatedAt: '2026-01-02T00:00:00.000Z',
      });

      expect(mergeWorktreeChatSessions(worktreeId, [authoritative], [live])).toEqual([
        expect.objectContaining({
          sessionId: 'ses_existing',
          prompt: 'Live title',
          cloudAgentSessionId: 'workspace_authoritative',
          status: 'active',
          sessionStatus: 'busy',
          sessionStatusUpdatedAt: '2026-01-02T00:00:00.000Z',
        }),
      ]);
    });

    it('keeps authoritative siblings and includes newly cached siblings from the selected worktree', () => {
      const authoritative = makeStoredSession('ses_authoritative', '2026-01-02T00:00:00.000Z', {
        worktreeId,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const newlyCreated = makeStoredSession('ses_new', '2026-01-03T00:00:00.000Z', {
        worktreeId,
        createdAt: '2026-01-03T00:00:00.000Z',
      });
      const unrelatedAuthoritative = makeStoredSession(
        'ses_authoritative_foreign',
        '2026-01-03T00:00:00.000Z',
        { worktreeId: 'worktree_foreign' }
      );
      const unrelatedCached = makeStoredSession('ses_cached_foreign', '2026-01-03T00:00:00.000Z', {
        worktreeId: 'worktree_foreign',
      });

      const result = mergeWorktreeChatSessions(
        worktreeId,
        [unrelatedAuthoritative, authoritative],
        [unrelatedCached, newlyCreated]
      );

      expect(result.map(session => session.sessionId)).toEqual(['ses_authoritative', 'ses_new']);
    });

    it('does not replace newer authoritative data with stale cached session data', () => {
      const authoritative = makeStoredSession('ses_existing', '2026-01-03T00:00:00.000Z', {
        worktreeId,
        prompt: 'Authoritative title',
        sessionStatus: 'idle',
      });
      const stale = makeStoredSession('ses_existing', '2026-01-02T00:00:00.000Z', {
        worktreeId,
        prompt: 'Stale title',
        sessionStatus: 'busy',
      });

      expect(mergeWorktreeChatSessions(worktreeId, [authoritative], [stale])).toEqual([
        expect.objectContaining({ prompt: 'Authoritative title', sessionStatus: 'idle' }),
      ]);
    });

    it('keeps optimistic cached titles when authoritative and cached timestamps match', () => {
      const authoritative = makeStoredSession('ses_existing', '2026-01-02T00:00:00.000Z', {
        worktreeId,
        prompt: 'Previous title',
      });
      const renamed = makeStoredSession('ses_existing', '2026-01-02T00:00:00.000Z', {
        worktreeId,
        prompt: 'Optimistically renamed',
      });

      expect(mergeWorktreeChatSessions(worktreeId, [authoritative], [renamed])).toEqual([
        expect.objectContaining({ prompt: 'Optimistically renamed' }),
      ]);
    });

    it('sorts chats by creation time and uses session identity for deterministic ties', () => {
      const latest = makeStoredSession('ses_latest', '2026-01-01T00:00:00.000Z', {
        worktreeId,
        createdAt: '2026-01-03T00:00:00.000Z',
      });
      const firstTie = makeStoredSession('ses_a', '2026-01-03T00:00:00.000Z', {
        worktreeId,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const secondTie = makeStoredSession('ses_b', '2026-01-02T00:00:00.000Z', {
        worktreeId,
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const result = mergeWorktreeChatSessions(worktreeId, [latest, secondTie], [firstTie]);

      expect(result.map(session => session.sessionId)).toEqual(['ses_a', 'ses_b', 'ses_latest']);
    });
  });

  describe('sidebar worktree grouping', () => {
    it('groups siblings before date bucketing so a worktree appears only once', () => {
      const sessions = [
        makeStoredSession('ses_today', '2026-01-03T12:00:00.000Z', {
          worktreeId: 'worktree_shared',
        }),
        makeStoredSession('ses_yesterday', '2026-01-02T12:00:00.000Z', {
          worktreeId: 'worktree_shared',
        }),
        makeStoredSession('ses_ungrouped', '2026-01-02T11:00:00.000Z'),
      ];

      const result = groupSidebarSessionsByDate(sessions, new Date('2026-01-03T18:00:00.000Z'));

      expect(result.map(group => ({ label: group.label, size: group.items.length }))).toEqual([
        { label: 'Today', size: 1 },
        { label: 'Yesterday', size: 1 },
      ]);
      expect(result[0]?.items[0]).toMatchObject({
        type: 'worktree',
        worktreeId: 'worktree_shared',
        sessions: [{ sessionId: 'ses_today' }, { sessionId: 'ses_yesterday' }],
      });
      expect(result[1]?.items[0]).toMatchObject({
        type: 'session',
        session: { sessionId: 'ses_ungrouped' },
      });
    });

    it('orders groups and their children by the newest sibling activity', () => {
      const result = groupSidebarSessions([
        makeStoredSession('ses_older_group', '2026-01-01T10:00:00.000Z', {
          worktreeId: 'worktree_latest',
        }),
        makeStoredSession('ses_ungrouped', '2026-01-02T10:00:00.000Z'),
        makeStoredSession('ses_newest_group', '2026-01-03T10:00:00.000Z', {
          worktreeId: 'worktree_latest',
        }),
      ]);

      expect(result[0]).toMatchObject({
        type: 'worktree',
        latestSession: { sessionId: 'ses_newest_group' },
        sessions: [{ sessionId: 'ses_newest_group' }, { sessionId: 'ses_older_group' }],
      });
      expect(result[1]).toMatchObject({ type: 'session', session: { sessionId: 'ses_ungrouped' } });
    });

    it('derives stable group labels from repository and branch metadata', () => {
      const [group] = groupSidebarSessions([
        makeStoredSession('ses_grouped', '2026-01-03T10:00:00.000Z', {
          repository: 'kilo/repo',
          branch: 'feature/shared-chat',
          worktreeId: 'worktree_shared',
        }),
      ]);
      if (group?.type !== 'worktree') throw new Error('Expected worktree group');

      expect(getSidebarWorktreeLabel(group)).toBe('kilo/repo · feature/shared-chat');
    });

    it.each([
      {
        name: 'Custom worktree name',
        defaultTitle: 'Authoritative first chat title',
        expected: 'Custom worktree name',
      },
      {
        name: null,
        defaultTitle: 'Authoritative first chat title',
        expected: 'Authoritative first chat title',
      },
      { name: null, defaultTitle: null, expected: 'kilo/repo · main' },
    ])('keeps $expected independent of visible chat titles and activity', details => {
      const first = makeStoredSession('ses_first', '2026-01-01T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        prompt: 'Visible older chat title',
      });
      const latest = makeStoredSession('ses_latest', '2026-01-03T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        prompt: 'Visible latest chat title',
      });
      const worktreeDetails = {
        worktree_shared: {
          name: details.name,
          defaultTitle: details.defaultTitle,
          prSession: null,
          sessions: [first, latest],
        },
      } satisfies Record<string, SidebarWorktreeDetails>;

      for (const sessions of [[first, latest], [latest], [{ ...first, prompt: 'Renamed chat' }]]) {
        const [group] = groupSidebarSessions(sessions, worktreeDetails);
        if (group?.type !== 'worktree') throw new Error('Expected worktree group');

        expect(getSidebarWorktreeLabel(group)).toBe(details.expected);
        expect(group.details).toBe(worktreeDetails.worktree_shared);
      }
    });

    it('carries authoritative metadata through date grouping without adding invisible worktrees', () => {
      const visible = makeStoredSession('ses_visible', '2026-01-03T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
      });
      const details: SidebarWorktreeDetails = {
        name: 'Named worktree',
        defaultTitle: 'First chat outside the filtered list',
        prSession: null,
        sessions: [visible],
      };
      const result = groupSidebarSessionsByDate([visible], new Date('2026-01-03T18:00:00.000Z'), {
        worktree_shared: details,
        worktree_hidden: details,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.items).toHaveLength(1);
      expect(result[0]?.items[0]).toMatchObject({
        type: 'worktree',
        worktreeId: 'worktree_shared',
        details,
        latestSession: visible,
      });
    });

    it('uses repository and branch instead of a visible chat title while metadata is absent', () => {
      const [group] = groupSidebarSessions([
        makeStoredSession('ses_filtered', '2026-01-03T10:00:00.000Z', {
          worktreeId: 'worktree_shared',
          prompt: 'This filtered chat must not become the worktree name',
          repository: '',
          branch: null,
        }),
      ]);
      if (group?.type !== 'worktree') throw new Error('Expected worktree group');

      expect(getSidebarWorktreeLabel(group)).toBe('Repository');
    });

    it('uses the most recently active PR-bearing sibling rather than the latest chat', () => {
      const olderPr = makeStoredSession('ses_older_pr', '2026-01-01T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr,
      });
      const latestPr = makeStoredSession('ses_latest_pr', '2026-01-02T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr: { ...associatedPr, number: 43 },
      });
      const latestChat = makeStoredSession('ses_latest_chat', '2026-01-03T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr: null,
      });
      const pendingChat = makeStoredSession('ses_pending_chat', '2026-01-04T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr: undefined,
      });
      const [group] = groupSidebarSessions([olderPr, latestChat, latestPr, pendingChat]);
      if (group?.type !== 'worktree') throw new Error('Expected worktree group');

      expect(group.latestSession).toBe(pendingChat);
      expect(getSidebarWorktreePrSession(group)).toBe(latestPr);
    });

    it('uses the existing deterministic sibling order for equally active PR sources', () => {
      const first = makeStoredSession('ses_a', '2026-01-03T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr,
      });
      const second = { ...first, sessionId: 'ses_b' };

      for (const sessions of [
        [first, second],
        [second, first],
      ]) {
        const [group] = groupSidebarSessions(sessions);
        if (group?.type !== 'worktree') throw new Error('Expected worktree group');

        expect(getSidebarWorktreePrSession(group)).toBe(second);
      }
    });

    it('prefers an authoritative PR source outside the visible group and honors confirmed absence', () => {
      const visible = makeStoredSession('ses_visible', '2026-01-03T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr,
      });
      const hidden = makeStoredSession('ses_hidden', '2026-01-04T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr: { ...associatedPr, number: 43 },
      });

      for (const prSession of [hidden, { ...hidden, associatedPr: undefined }, null]) {
        const [group] = groupSidebarSessions([visible], {
          worktree_shared: {
            name: null,
            defaultTitle: null,
            prSession,
            sessions: [visible, hidden],
          },
        });
        if (group?.type !== 'worktree') throw new Error('Expected worktree group');

        expect(getSidebarWorktreePrSession(group)).toBe(prSession);
      }
    });

    it('preserves a real pending PR source only when a branch can show the loading indicator', () => {
      const confirmed = makeStoredSession('ses_confirmed', '2026-01-03T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr: null,
      });
      const pending = makeStoredSession('ses_pending', '2026-01-02T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        associatedPr: undefined,
      });
      const withoutBranch = makeStoredSession('ses_unbranched', '2026-01-04T10:00:00.000Z', {
        worktreeId: 'worktree_shared',
        branch: null,
        associatedPr: undefined,
      });
      const [group] = groupSidebarSessions([confirmed, pending, withoutBranch]);
      const [loadedGroup] = groupSidebarSessions([confirmed, withoutBranch]);
      if (group?.type !== 'worktree' || loadedGroup?.type !== 'worktree') {
        throw new Error('Expected worktree groups');
      }

      expect(getSidebarWorktreePrSession(group)).toBe(pending);
      expect(getSidebarWorktreePrSession(loadedGroup)).toBeNull();
    });

    it('prioritizes attention from any child over another running sibling', () => {
      const sessions = [
        makeStoredSession('ses_running', '2026-01-03T12:00:00.000Z', {
          sessionStatus: 'busy',
          sessionStatusUpdatedAt: '2026-01-03T12:00:00.000Z',
        }),
        makeStoredSession('ses_waiting', '2026-01-03T11:00:00.000Z', {
          sessionStatus: 'question',
          sessionStatusUpdatedAt: '2026-01-03T11:00:00.000Z',
        }),
      ];

      expect(getSidebarWorktreeActivity(sessions, new Map())).toEqual({
        status: 'question',
        statusUpdatedAt: '2026-01-03T11:00:00.000Z',
        isLive: false,
      });
    });

    it('reflects live running status even before a stored status update arrives', () => {
      const sessions = [makeStoredSession('ses_live', '2026-01-03T12:00:00.000Z')];

      expect(getSidebarWorktreeActivity(sessions, new Map([['ses_live', 'retry']]))).toEqual({
        status: 'retry',
        statusUpdatedAt: null,
        isLive: true,
      });
    });

    it.each(['question', 'permission', 'busy', 'retry'])(
      'includes a hidden sibling with %s status outside the displayed slice',
      status => {
        const visible = makeStoredSession('ses_visible', '2026-01-03T12:00:00.000Z');
        const hidden = makeStoredSession('ses_hidden', '2025-01-03T12:00:00.000Z', {
          sessionStatus: status,
          sessionStatusUpdatedAt: '2026-01-03T12:00:00.000Z',
        });

        expect(getSidebarWorktreeActivity([visible], new Map(), [visible, hidden])).toEqual({
          status,
          statusUpdatedAt: hidden.sessionStatusUpdatedAt,
          isLive: false,
        });
      }
    );

    it('matches hidden live sessions only against authorized group membership', () => {
      const visible = makeStoredSession('ses_visible', '2026-01-03T12:00:00.000Z');
      const hidden = makeStoredSession('ses_hidden', '2025-01-03T12:00:00.000Z');
      const active = new Map([
        ['ses_hidden', 'retry'],
        ['ses_other_tenant', 'permission'],
      ]);

      expect(getSidebarWorktreeActivity([visible], active, [visible, hidden])).toEqual({
        status: 'retry',
        statusUpdatedAt: null,
        isLive: true,
      });
      expect(getSidebarWorktreeActivity([visible], active, [visible])).toEqual({
        status: null,
        statusUpdatedAt: null,
        isLive: false,
      });
    });

    it.each([false, true])(
      'prefers the newer idle completion over a stale busy snapshot (newer visible=%s)',
      newerVisible => {
        const busy = makeStoredSession('ses_same', '2026-01-03T12:00:00.000Z', {
          sessionStatus: 'busy',
          sessionStatusUpdatedAt: '2026-01-03T12:00:00.000Z',
        });
        const idle = {
          ...busy,
          sessionStatus: 'idle',
          sessionStatusUpdatedAt: '2026-01-03T12:01:00.000Z',
        };

        expect(
          getSidebarWorktreeActivity([newerVisible ? idle : busy], new Map(), [
            newerVisible ? busy : idle,
          ])
        ).toEqual({ status: null, statusUpdatedAt: null, isLive: false });
      }
    );

    it('lets live idle completion clear stale stored attention instead of taking maximum priority', () => {
      const waiting = makeStoredSession('ses_waiting', '2026-01-03T12:00:00.000Z', {
        sessionStatus: 'question',
      });

      expect(getSidebarWorktreeActivity([], new Map([['ses_waiting', 'idle']]), [waiting])).toEqual(
        {
          status: null,
          statusUpdatedAt: null,
          isLive: true,
        }
      );
      expect(
        getSidebarWorktreeActivity([], new Map([['ses_waiting', 'busy']]), [waiting]).status
      ).toBe('question');
    });

    it('lets a hidden foreground completion override stale snapshots without idling another sibling', () => {
      const foreground = makeStoredSession('ses_foreground', '2026-01-03T12:00:00.000Z', {
        sessionStatus: 'question',
      });
      const background = makeStoredSession('ses_background', '2026-01-03T12:00:00.000Z', {
        sessionStatus: 'busy',
      });
      const active = new Map([['ses_foreground', 'busy']]);
      const completed = { sessionId: 'ses_foreground', status: 'idle' };

      expect(getSidebarWorktreeActivity([], active, [foreground], completed).status).toBeNull();
      expect(
        getSidebarWorktreeActivity([background], active, [foreground, background], completed).status
      ).toBe('busy');
      expect(
        getSidebarWorktreeActivity([], active, [foreground], {
          sessionId: 'ses_other_tenant',
          status: 'idle',
        }).status
      ).toBe('question');
    });

    it('prioritizes hidden attention over a foreground session that starts running', () => {
      const visible = makeStoredSession('ses_visible', '2026-01-03T12:00:00.000Z');
      const hidden = makeStoredSession('ses_hidden', '2025-01-03T12:00:00.000Z');

      expect(
        getSidebarWorktreeActivity(
          [visible],
          new Map([['ses_hidden', 'permission']]),
          [visible, hidden],
          { sessionId: 'ses_visible', status: 'busy' }
        ).status
      ).toBe('permission');
    });
  });

  describe('patchSidebarWorktreeSessionStatus', () => {
    const initial = {
      worktrees: {
        worktree_shared: {
          name: 'Named worktree',
          defaultTitle: null,
          prSession: null,
          sessions: [
            {
              sessionId: 'ses_hidden',
              sessionStatus: 'busy',
              sessionStatusUpdatedAt: '2026-01-03T12:00:00.000Z',
            },
          ],
        },
      },
    } satisfies Parameters<typeof patchSidebarWorktreeSessionStatus>[0];

    it('updates a hidden member through attention and completion without changing membership', () => {
      const waiting = patchSidebarWorktreeSessionStatus(initial, {
        sessionId: 'ses_hidden',
        sessionStatus: 'question',
        sessionStatusUpdatedAt: '2026-01-03T12:01:00.000Z',
      });
      expect(
        getSidebarWorktreeActivity([], new Map(), waiting.worktrees.worktree_shared.sessions).status
      ).toBe('question');

      const completed = patchSidebarWorktreeSessionStatus(waiting, {
        sessionId: 'ses_hidden',
        sessionStatus: 'idle',
        sessionStatusUpdatedAt: '2026-01-03T12:02:00.000Z',
      });
      expect(completed.worktrees.worktree_shared.sessions).toHaveLength(1);
      expect(
        getSidebarWorktreeActivity([], new Map(), completed.worktrees.worktree_shared.sessions)
          .status
      ).toBeNull();
      expect(initial.worktrees.worktree_shared.sessions[0].sessionStatus).toBe('busy');
      expect(completed.worktrees.worktree_shared.name).toBe(initial.worktrees.worktree_shared.name);
      expect(
        patchSidebarWorktreeSessionStatus(completed, waiting.worktrees.worktree_shared.sessions[0])
      ).toBe(completed);
    });

    it('ignores unknown or foreign session identities and older or duplicate status updates', () => {
      expect(
        patchSidebarWorktreeSessionStatus(initial, {
          sessionId: 'ses_foreign',
          sessionStatus: 'permission',
          sessionStatusUpdatedAt: '2026-01-03T12:02:00.000Z',
        })
      ).toBe(initial);
      expect(
        patchSidebarWorktreeSessionStatus(initial, {
          sessionId: 'ses_hidden',
          sessionStatus: 'idle',
          sessionStatusUpdatedAt: '2026-01-03T11:59:00.000Z',
        })
      ).toBe(initial);
      expect(
        patchSidebarWorktreeSessionStatus(initial, initial.worktrees.worktree_shared.sessions[0])
      ).toBe(initial);
    });
  });

  describe('dbSessionMatchesSearch', () => {
    it('matches by session_id substring', () => {
      const session = makeDbSession('abc-123-def', '2026-01-01T00:00:00.000Z');
      expect(dbSessionMatchesSearch(session, '123')).toBe(true);
    });

    it('matches by title substring (case-insensitive)', () => {
      const session = makeDbSession('ses-1', '2026-01-01T00:00:00.000Z');
      const withTitle = { ...session, title: 'Hello World' };
      expect(dbSessionMatchesSearch(withTitle, 'world')).toBe(true);
    });

    it('returns false when neither session_id nor title matches', () => {
      const session = makeDbSession('ses-1', '2026-01-01T00:00:00.000Z');
      expect(dbSessionMatchesSearch(session, 'zzz')).toBe(false);
    });
  });

  describe('createSidebarQueryReconciler', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('coalesces status event bursts into one delayed authoritative reconciliation', () => {
      const reconcile = jest.fn();
      const reconciler = createSidebarQueryReconciler(reconcile);

      reconciler.schedule();
      reconciler.schedule();
      jest.advanceTimersByTime(SIDEBAR_RECONCILE_DELAY_MS - 1);
      expect(reconcile).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(reconcile).toHaveBeenCalledTimes(1);

      reconciler.schedule();
      jest.advanceTimersByTime(SIDEBAR_RECONCILE_DELAY_MS);
      expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('reconciles immediately after reconnect without running a pending delayed refresh', () => {
      const reconcile = jest.fn();
      const reconciler = createSidebarQueryReconciler(reconcile);

      reconciler.schedule();
      reconciler.reconcileNow();
      expect(reconcile).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(SIDEBAR_RECONCILE_DELAY_MS);
      expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('cancels pending reconciliation when its listener owner is disposed', () => {
      const reconcile = jest.fn();
      const reconciler = createSidebarQueryReconciler(reconcile);

      reconciler.schedule();
      reconciler.dispose();
      jest.advanceTimersByTime(SIDEBAR_RECONCILE_DELAY_MS);

      expect(reconcile).not.toHaveBeenCalled();
    });
  });
});

type ChatSidebarProps = ComponentProps<typeof ChatSidebar>;

function renderChatSidebar(overrides: Partial<ChatSidebarProps> = {}, openMenus = false): string {
  mockRenderOpenMenus = openMenus;
  jest.mocked(DropdownMenuItem).mockClear();
  jest.mocked(SessionPrIndicator).mockClear();
  return renderToStaticMarkup(
    createElement(ChatSidebar, {
      sessions: [
        makeStoredSession('ses_latest', '2026-01-03T10:00:00.000Z', {
          worktreeId: 'worktree_shared',
          associatedPr: null,
        }),
      ],
      ...overrides,
    })
  );
}

function getSidebarMenuItemProps(label: string): ComponentProps<typeof DropdownMenuItem> {
  const props = jest
    .mocked(DropdownMenuItem)
    .mock.calls.find(([props]) => React.Children.toArray(props.children).includes(label))?.[0];
  if (!props) throw new Error(`Menu item not rendered: ${label}`);
  return props;
}

function getSidebarButtonMarkup(html: string, label: string): string {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const button = buttons.find(markup => markup.includes(`aria-label="${label}"`));
  if (!button) throw new Error(`Button not rendered: ${label}`);
  return button;
}

describe('ChatSidebar worktree controls', () => {
  it('renders hidden sibling activity from complete worktree details during search', () => {
    const visible = makeStoredSession('ses_visible', '2026-01-03T12:00:00.000Z', {
      worktreeId: 'worktree_shared',
      associatedPr: null,
    });
    const hidden = makeStoredSession('ses_hidden', '2025-01-03T12:00:00.000Z', {
      worktreeId: 'worktree_shared',
      sessionStatus: 'question',
    });
    const props: Partial<ChatSidebarProps> = {
      sessions: [visible],
      searchQuery: 'visible',
      worktreeDetails: {
        worktree_shared: {
          name: null,
          defaultTitle: null,
          prSession: null,
          sessions: [visible, hidden],
        },
      },
    };

    expect(renderChatSidebar(props)).toContain('aria-label="Waiting for answer"');
    expect(
      renderChatSidebar({
        ...props,
        foregroundSession: { sessionId: hidden.sessionId, status: 'idle' },
      })
    ).not.toContain('Waiting for answer');
  });

  it('renders a hidden live sibling on its worktree rather than relying on displayed chats', () => {
    const visible = makeStoredSession('ses_visible', '2026-01-03T12:00:00.000Z', {
      worktreeId: 'worktree_shared',
      associatedPr: null,
    });
    const hidden = makeStoredSession('ses_hidden', '2025-01-03T12:00:00.000Z');
    const html = renderChatSidebar({
      sessions: [visible],
      activeSessions: [
        { id: hidden.sessionId, status: 'retry', title: 'Hidden chat', connectionId: 'cli' },
      ],
      worktreeDetails: {
        worktree_shared: {
          name: null,
          defaultTitle: null,
          prSession: null,
          sessions: [visible, hidden],
        },
      },
    });
    const worktreeMarkup = html.slice(html.indexOf('aria-label="Open worktree'));

    expect(worktreeMarkup).toContain('<title>Retrying</title>');
  });

  it.each([
    { create: false, rename: false, remove: false },
    { create: true, rename: false, remove: false },
    { create: false, rename: true, remove: false },
    { create: false, rename: false, remove: true },
    { create: true, rename: true, remove: false },
    { create: true, rename: false, remove: true },
    { create: false, rename: true, remove: true },
    { create: true, rename: true, remove: true },
  ])('independently gates worktree capabilities: %j', capabilities => {
    const html = renderChatSidebar(
      {
        onCreateWorktreeChat: capabilities.create ? async () => true : undefined,
        onRenameWorktree: capabilities.rename ? async () => undefined : undefined,
        onDeleteWorktree: capabilities.remove ? () => undefined : undefined,
        onRenameSession: async () => undefined,
        onDeleteSession: () => undefined,
      },
      true
    );

    expect(html.includes('Worktree actions for')).toBe(
      capabilities.create || capabilities.rename || capabilities.remove
    );
    expect(html.includes('New chat')).toBe(capabilities.create);
    expect(html.includes('Rename worktree')).toBe(capabilities.rename);
    expect(html.includes('Delete worktree')).toBe(capabilities.remove);
    expect(html).not.toContain('Delete session');
    expect(html).not.toContain('Session actions for');
  });

  it('creates from the latest chat but delegates deletion using only the worktree ID', () => {
    const createdFrom: string[] = [];
    const deletedWorktrees: string[] = [];
    const deletedSessions: string[] = [];
    const openedSessions: string[] = [];
    renderChatSidebar(
      {
        sessions: [
          makeStoredSession('ses_older', '2026-01-01T10:00:00.000Z', {
            worktreeId: 'worktree_shared',
          }),
          makeStoredSession('ses_latest', '2026-01-03T10:00:00.000Z', {
            worktreeId: 'worktree_shared',
          }),
        ],
        onCreateWorktreeChat: async sessionId => {
          createdFrom.push(sessionId);
          return true;
        },
        onDeleteWorktree: worktreeId => deletedWorktrees.push(worktreeId),
        onDeleteSession: sessionId => deletedSessions.push(sessionId),
        onOpenSession: sessionId => openedSessions.push(sessionId),
      },
      true
    );

    getSidebarMenuItemProps('New chat').onSelect?.(new Event('select'));
    getSidebarMenuItemProps('Delete worktree').onSelect?.(new Event('select'));

    expect(createdFrom).toEqual(['ses_latest']);
    expect(deletedWorktrees).toEqual(['worktree_shared']);
    expect(deletedSessions).toEqual([]);
    expect(openedSessions).toEqual([]);
  });

  it.each([null, 'busy'])('shares the session action slot for status=%s', sessionStatus => {
    const worktreeSession = makeStoredSession('ses_grouped', '2026-01-03T10:00:00.000Z', {
      worktreeId: 'worktree_shared',
      associatedPr: null,
      sessionStatus,
    });
    const standalone = { ...worktreeSession, sessionId: 'ses_standalone', worktreeId: null };
    const html = renderChatSidebar({
      sessions: [worktreeSession, standalone],
      onDeleteWorktree: () => undefined,
      onDeleteSession: () => undefined,
    });
    const slots = html.match(/class="group\/session-actions[^"]*"/g) ?? [];
    const worktreeButton = getSidebarButtonMarkup(html, 'Worktree actions for kilo/repo · main');
    const sessionButton = getSidebarButtonMarkup(html, `Session actions for ${standalone.prompt}`);

    expect(slots).toHaveLength(2);
    expect(slots[0]).toBe(slots[1]);
    expect(worktreeButton.match(/class="([^"]*)"/)?.[1]).toBe(
      sessionButton.match(/class="([^"]*)"/)?.[1]
    );
    expect(html.match(/group-focus-within\/session-actions:invisible/g)).toHaveLength(2);
    expect(html.match(/focus-within:opacity-100/g)).toHaveLength(2);
    expect(html.match(/\[@media\(any-pointer:coarse\)\]:opacity-100/g)).toHaveLength(2);
    expect(html.match(/\[@media\(hover:none\)\]:opacity-100/g)).toHaveLength(2);
    expect(worktreeButton).not.toContain('tabindex="-1"');
  });

  it('renders sibling PR information outside the worktree navigation button with a real chat ID', () => {
    const source = makeStoredSession('ses_pr_source', '2026-01-02T10:00:00.000Z', {
      worktreeId: 'worktree_shared',
      associatedPr,
    });
    const latest = makeStoredSession('ses_latest', '2026-01-03T10:00:00.000Z', {
      worktreeId: 'worktree_shared',
      associatedPr: null,
    });
    const html = renderChatSidebar({
      sessions: [source, latest],
      onDeleteWorktree: () => undefined,
    });

    expect(html).toContain('aria-label="open pull request #42"');
    expect(getSidebarButtonMarkup(html, 'Open worktree kilo/repo · main')).not.toContain(
      'open pull request'
    );
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
    expect(jest.mocked(SessionPrIndicator).mock.calls.map(([props]) => props.session)).toEqual([
      source,
    ]);
  });

  it('uses parent metadata for a filtered worktree and honors an authoritative missing PR', () => {
    const source = makeStoredSession('ses_hidden_pr', '2026-01-04T10:00:00.000Z', {
      worktreeId: 'worktree_shared',
      associatedPr,
    });
    const details: SidebarWorktreeDetails = {
      name: 'Custom worktree',
      defaultTitle: 'Authoritative first chat',
      prSession: source,
      sessions: [source],
    };
    const html = renderChatSidebar({ worktreeDetails: { worktree_shared: details } });

    expect(html).toContain('aria-label="Open worktree Custom worktree"');
    expect(jest.mocked(SessionPrIndicator).mock.calls.map(([props]) => props.session)).toEqual([
      source,
    ]);

    const withoutPr = renderChatSidebar({
      sessions: [source],
      worktreeDetails: { worktree_shared: { ...details, prSession: null } },
    });

    expect(withoutPr).toContain('aria-label="Open worktree Custom worktree"');
    expect(withoutPr).not.toContain('open pull request');
    expect(jest.mocked(SessionPrIndicator).mock.calls).toHaveLength(0);
  });

  it.each(['ses_latest', 'ses_other'])(
    'keeps unrelated actions available during creation from %s',
    sourceId => {
      const html = renderChatSidebar(
        {
          onCreateWorktreeChat: async () => true,
          onRenameWorktree: async () => undefined,
          onDeleteWorktree: () => undefined,
          creatingWorktreeSourceSessionId: sourceId,
        },
        true
      );

      expect(getSidebarButtonMarkup(html, 'Worktree actions for kilo/repo · main')).not.toContain(
        'disabled=""'
      );
      expect(getSidebarMenuItemProps('New chat').disabled).toBe(true);
      expect(getSidebarMenuItemProps('Rename worktree').disabled).not.toBe(true);
      expect(getSidebarMenuItemProps('Delete worktree').disabled).toBe(sourceId === 'ses_latest');
      expect(html.includes('aria-label="Creating chat"')).toBe(sourceId === 'ses_latest');
    }
  );

  it('disables navigation and mutation controls only for the deleting worktree', () => {
    const deleting = makeStoredSession('ses_deleting', '2026-01-03T10:00:00.000Z', {
      worktreeId: 'worktree_deleting',
      branch: 'deleting',
      associatedPr: null,
    });
    const available = {
      ...deleting,
      sessionId: 'ses_available',
      worktreeId: 'worktree_available',
      branch: 'available',
    };
    const html = renderChatSidebar(
      {
        sessions: [deleting, available],
        deletingWorktreeId: deleting.worktreeId ?? undefined,
        onCreateWorktreeChat: async () => true,
        onRenameWorktree: async () => undefined,
        onDeleteWorktree: () => undefined,
      },
      true
    );

    expect(getSidebarButtonMarkup(html, 'Open worktree kilo/repo · deleting')).toContain(
      'disabled=""'
    );
    expect(html).toContain('aria-label="Deleting worktree"');
    expect(html).not.toContain('Worktree actions for kilo/repo · deleting');
    expect(getSidebarButtonMarkup(html, 'Open worktree kilo/repo · available')).not.toContain(
      'disabled=""'
    );
    expect(
      getSidebarButtonMarkup(html, 'Worktree actions for kilo/repo · available')
    ).not.toContain('disabled=""');
    expect(getSidebarMenuItemProps('New chat').disabled).toBe(false);
    expect(getSidebarMenuItemProps('Rename worktree').disabled).not.toBe(true);
    expect(getSidebarMenuItemProps('Delete worktree').disabled).toBe(false);
  });

  it('preserves standalone session permissions and deletion callbacks', () => {
    const standalone = makeStoredSession('ses_standalone', '2026-01-03T10:00:00.000Z', {
      prompt: 'Standalone chat',
      associatedPr: null,
    });
    const deletedSessions: string[] = [];
    const worktreeCallbacks: Partial<ChatSidebarProps> = {
      onCreateWorktreeChat: async () => true,
      onRenameWorktree: async () => undefined,
      onDeleteWorktree: () => undefined,
    };
    const readOnlyHtml = renderChatSidebar({ sessions: [standalone], ...worktreeCallbacks }, true);

    expect(readOnlyHtml).not.toContain('Session actions for');
    expect(readOnlyHtml).not.toContain('Worktree actions for');

    const html = renderChatSidebar(
      {
        sessions: [standalone],
        ...worktreeCallbacks,
        onRenameSession: async () => undefined,
        onDeleteSession: sessionId => deletedSessions.push(sessionId),
      },
      true
    );
    getSidebarMenuItemProps('Delete session').onClick?.({
      stopPropagation: () => undefined,
    } as React.MouseEvent<HTMLDivElement>);

    expect(html).toContain('Session actions for Standalone chat');
    expect(html).toContain('>Rename<');
    expect(html).not.toContain('Rename worktree');
    expect(html).not.toContain('Delete worktree');
    expect(deletedSessions).toEqual([standalone.sessionId]);
  });
});
