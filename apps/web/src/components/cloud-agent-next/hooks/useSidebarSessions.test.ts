import type { StoredSession } from '../types';
import {
  deriveForegroundSessionStatus,
  getRunningSessionSortTime,
  getSidebarWorktreeActivity,
  groupSidebarSessionsByDate,
  SIDEBAR_RUNNING_BUMP_INTERVAL_MS,
} from './sidebar-session-model';
import { groupSidebarWorkspaces, workspaceChatToStoredSession } from './sidebar-workspace-model';
import {
  getMissingWorkspaceAncestorIds,
  getWorkspaceSummaryRefetchInterval,
} from './useWorkspaceSummaries';
import { mergeWorkspaceChats } from './useWorkspaceChats';
import { sidebarListInput } from './sidebar-queries';
import {
  workspaceChatFixture,
  workspaceSummaryFixture,
  WORKSPACE_FIXTURE_TIME,
} from './workspace-summary-test-fixtures';

const now = Date.parse(WORKSPACE_FIXTURE_TIME);

describe('workspace sidebar summaries', () => {
  it('renders workspace rows without a recent root-chat list', () => {
    const summary = workspaceSummaryFixture({ lastActivityAt: '2025-01-01T00:00:00Z' });
    const groups = groupSidebarWorkspaces([], {}, [summary]);
    expect(groups).toHaveLength(1);
    expect(groups[0].summary).toBe(summary);
    expect(groups[0].latestSession.sessionId).toBe(summary.latestOpenSessionId);
    expect(groups[0].details?.baseSha).toBe(summary.baseSha);
  });

  it('does not reconstruct workspace rows from server search or recent-chat results', () => {
    const summary = workspaceSummaryFixture();
    expect(
      groupSidebarWorkspaces([workspaceChatToStoredSession(summary, workspaceChatFixture())])
    ).toEqual([]);
  });

  it('keeps pending local chats separate, and yields to server chat summaries', () => {
    const summary = workspaceSummaryFixture();
    const server = workspaceChatToStoredSession(summary, workspaceChatFixture());
    const pending = { ...server, sessionId: 'ses_pending', localSync: 'syncing' as const };
    const staleLocal = { ...server, prompt: 'Local title', localSync: 'syncing' as const };
    expect(mergeWorkspaceChats(summary.worktreeId, [server], [pending, staleLocal])).toEqual([
      server,
      pending,
    ]);
    const [group] = groupSidebarWorkspaces([pending], {}, [summary]);
    expect(group.sessions.map(chat => chat.sessionId)).toEqual(['ses_pending']);
    expect(group.summary).toBe(summary);
  });

  it('preserves all server stack layers and their depth', () => {
    const root = workspaceSummaryFixture();
    const layers = Array.from({ length: 8 }, (_, index) =>
      workspaceSummaryFixture({
        worktreeId: `worktree_layer_${index}`,
        stackRootId: root.worktreeId,
        stackDepth: index + 1,
      })
    );
    const [group] = groupSidebarWorkspaces([], {}, [root, ...layers]);
    expect(group.stackLayers?.map(layer => layer.worktreeId)).toEqual(
      layers.map(layer => layer.worktreeId)
    );
    expect(group.stackLayers?.at(-1)?.stackDepth).toBe(8);
  });

  it('uses only the server status source chat for immediate foreground or live changes', () => {
    const summary = workspaceSummaryFixture({
      sessionStatus: 'busy',
      status: { ...workspaceSummaryFixture().status, kind: 'running', sessionStatus: 'busy' },
    });
    const [group] = groupSidebarWorkspaces([], {}, [summary]);
    expect(
      getSidebarWorktreeActivity(group, new Map([['ses_other', 'question']]), {
        sessionId: 'ses_other',
        status: 'failed',
      }).status
    ).toBe('busy');
    expect(getSidebarWorktreeActivity(group, new Map([['ses_root', 'question']])).status).toBe(
      'question'
    );
    expect(
      getSidebarWorktreeActivity(group, new Map([['ses_root', 'busy']]), {
        sessionId: 'ses_root',
        status: 'idle',
      })
    ).toEqual({ status: null, statusUpdatedAt: null, isLive: false });
  });

  it('uses the latest open chat as the workspace navigation target without chat details', () => {
    const summary = workspaceSummaryFixture({
      latestSessionId: 'ses_closed',
      latestOpenSessionId: 'ses_root',
    });
    const [group] = groupSidebarWorkspaces([], {}, [summary]);
    expect(group.latestSession.sessionId).toBe('ses_root');
    expect(group.sessions).toEqual([]);
  });
});

describe('workspace polling', () => {
  it('does not poll an idle completed workspace with a cloud-agent ID', () => {
    expect(
      getWorkspaceSummaryRefetchInterval(
        workspaceSummaryFixture({ cloudAgentSessionId: 'workspace_synthetic' }),
        now
      )
    ).toBe(false);
  });

  it('polls only running work, open runs, or pending PR information', () => {
    expect(
      getWorkspaceSummaryRefetchInterval(workspaceSummaryFixture({ sessionStatus: 'busy' }), now)
    ).toBe(30_000);
    expect(
      getWorkspaceSummaryRefetchInterval(workspaceSummaryFixture({ hasOpenRun: true }), now)
    ).toBe(30_000);
    expect(
      getWorkspaceSummaryRefetchInterval(
        workspaceSummaryFixture({ sessionStatus: 'question' }),
        now
      )
    ).toBe(false);
  });

  it.each(['busy', 'retry'])(
    'stops stale %s polling after exactly three hours, including an open run',
    sessionStatus => {
      const summary = workspaceSummaryFixture();
      const stale = {
        ...summary,
        hasOpenRun: true,
        sessionStatus,
        status: {
          ...summary.status,
          statusUpdatedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
        },
      };
      expect(getWorkspaceSummaryRefetchInterval(stale, now)).toBe(false);
      expect(getWorkspaceSummaryRefetchInterval(stale, now - 1)).toBe(30_000);
    }
  );
});

describe('stack summary lookup', () => {
  it('reuses cached ancestors without requesting an unfiltered list', () => {
    const root = workspaceSummaryFixture();
    const child = workspaceSummaryFixture({
      worktreeId: 'worktree_child',
      parentWorktreeId: root.worktreeId,
      stackRootId: root.worktreeId,
    });
    expect(getMissingWorkspaceAncestorIds([child.worktreeId], [root, child])).toEqual([]);
    expect(getMissingWorkspaceAncestorIds([child.worktreeId], [child])).toEqual([root.worktreeId]);
  });

  it('batches the first missing ancestor of each chain and bounds cycles', () => {
    const left = workspaceSummaryFixture({
      worktreeId: 'left',
      parentWorktreeId: 'missing-parent',
    });
    const right = workspaceSummaryFixture({
      worktreeId: 'right',
      parentWorktreeId: 'missing-parent',
    });
    expect(getMissingWorkspaceAncestorIds(['left', 'right', 'unknown'], [left, right])).toEqual([
      'missing-parent',
      'unknown',
    ]);
    expect(
      getMissingWorkspaceAncestorIds(
        ['left'],
        [
          { ...left, parentWorktreeId: 'right' },
          { ...right, parentWorktreeId: 'left' },
        ]
      )
    ).toEqual([]);
  });
});

describe('standalone sidebar sessions', () => {
  it('explicitly excludes workspace chats from the general sidebar list', () => {
    expect(
      sidebarListInput({
        organizationId: null,
        createdOnPlatform: undefined,
        gitUrl: undefined,
        updatedSince: WORKSPACE_FIXTURE_TIME,
      }).standaloneOnly
    ).toBe(true);
  });

  it('preserves the 60-second running sort step', () => {
    const session = workspaceChatToStoredSession(workspaceSummaryFixture(), workspaceChatFixture());
    const moving = { ...session, lastActivityAt: new Date(now + 59_999).toISOString() };
    expect(getRunningSessionSortTime(moving, true)).toBe(now);
    expect(
      getRunningSessionSortTime(
        { ...moving, lastActivityAt: new Date(now + 60_000).toISOString() },
        true
      )
    ).toBe(now + SIDEBAR_RUNNING_BUMP_INTERVAL_MS);
  });

  it('groups standalone sessions by activity without workspace dates', () => {
    const session = workspaceChatToStoredSession(workspaceSummaryFixture(), workspaceChatFixture());
    const standalone: StoredSession = { ...session, worktreeId: null };
    expect(groupSidebarSessionsByDate([standalone], new Date(now))[0]).toMatchObject({
      label: 'Today',
      items: [{ type: 'session', session: standalone }],
    });
  });
});

describe('foreground feedback', () => {
  const foreground = {
    currentSessionId: 'ses_root',
    organizationId: null,
    activeSessionType: 'cloud-agent' as const,
    fetchedSessionData: { kiloSessionId: 'ses_root', organizationId: null },
    activity: { type: 'idle' as const },
    isStreaming: false,
    activeQuestion: null,
    activePermission: null,
    cloudStatus: null,
    pendingMessages: new Map(),
  };
  it('does not use foreground status from another session or organization', () => {
    expect(
      deriveForegroundSessionStatus({
        ...foreground,
        fetchedSessionData: { kiloSessionId: 'ses_other', organizationId: null },
      })
    ).toBeNull();
    expect(
      deriveForegroundSessionStatus({ ...foreground, organizationId: 'synthetic-organization' })
    ).toBeNull();
  });
  it('keeps permission, question and streaming feedback immediate', () => {
    expect(
      deriveForegroundSessionStatus({
        ...foreground,
        activePermission: { requestId: 'permission' },
      })
    ).toBe('permission');
    expect(
      deriveForegroundSessionStatus({ ...foreground, activeQuestion: { requestId: 'question' } })
    ).toBe('question');
    expect(deriveForegroundSessionStatus({ ...foreground, isStreaming: true })).toBe('busy');
  });
});
