/* eslint-disable max-lines -- one cohesive headless-action suite sharing the trpcClient harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { readStoredValue } from '@/lib/auth/secure-store-value';

import {
  type GlanceableSink,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from './sink-registry';
import { setSurfaceExtras } from './surface-extras';
import {
  failureFeedback,
  oldestPendingPermissionId,
  resolveWaitingSession,
  runningFeedback,
  runWidgetAction,
  type WaitingSessionRow,
} from './widget-actions';

const ORGANIZATION_KEY = 'selected-organization';
const USER_KEY = 'active-user-id';
const MODEL_KEY = 'agent-model-preference';
const DRAFT_KEY = 'agent-composer:new';

const mocks = vi.hoisted(() => {
  const trpc: Record<string, unknown> = {};
  return {
    secure: new Map<string, string>(),
    trpc,
    loadDraft: vi.fn(),
    clearDraft: vi.fn(),
    // The publication gate `lib/glanceable/cleanup` owns: a terminal blank bump
    // and the lost-org latch, driven per case.
    blankEpoch: 0,
    orgLost: false,
  };
});

vi.mock('./cleanup', () => ({
  getTerminalBlankEpoch: () => mocks.blankEpoch,
  isGlanceableOrgLost: () => mocks.orgLost,
}));

vi.mock('@/lib/auth/secure-store-value', () => ({
  readStoredValue: vi.fn(async (key: string) => {
    await Promise.resolve();
    return mocks.secure.get(key) ?? null;
  }),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

vi.mock('@/lib/trpc', () => ({ trpcClient: mocks.trpc }));

vi.mock('@/lib/persist/drafts', () => ({
  NEW_SESSION_DRAFT_KEY: 'agent-composer:new',
  isStringDraft: (value: unknown) => typeof value === 'string',
  loadDraft: mocks.loadDraft,
  clearDraft: mocks.clearDraft,
}));

vi.mock('./persist', () => ({
  getLastGlanceableSnapshot: () => null,
}));

function query<T>(result: T) {
  return { query: vi.fn().mockResolvedValue(result), result };
}

function mutate<T>(result: T) {
  return { mutate: vi.fn().mockResolvedValue(result), result };
}

type SessionRow = WaitingSessionRow & { title?: string };

/** Wire the trpcClient surface the actions use. */
function wireTrpc(options: {
  sessions?: SessionRow[];
  cloudAgentSessionId?: string | null;
  permissions?: unknown[];
  listBitbucket?: { status: string; repositories: unknown[] };
}) {
  const activeSessions = { list: query({ sessions: options.sessions ?? [] }) };
  const cliSessionsV2 = {
    get: query({ cloud_agent_session_id: options.cloudAgentSessionId ?? null }),
    recentRepositories: query({
      repositories: [{ gitUrl: 'https://github.com/acme/widgets.git' }],
    }),
  };
  const getPendingInteractions = query({
    questions: [],
    permissions: options.permissions ?? [],
  });
  const answerPermission = mutate({ success: true });
  const prepareSession = mutate({ cloudAgentSessionId: 'workspace_1' });
  const listBitbucketRepositories = query(
    options.listBitbucket ?? { status: 'unavailable', repositories: [] }
  );
  // The organization namespace is a distinct surface: the personal
  // `getPendingInteractions` refuses an organization session, so the action must
  // call the organization twin. Separate spies let a case prove which one ran.
  const organizationGetPendingInteractions = query({
    questions: [],
    permissions: options.permissions ?? [],
  });
  const organizationAnswerPermission = mutate({ success: true });
  const cloudAgentNext = {
    getPendingInteractions,
    answerPermission,
    prepareSession,
    listBitbucketRepositories,
  };
  mocks.trpc.activeSessions = activeSessions;
  mocks.trpc.cliSessionsV2 = cliSessionsV2;
  mocks.trpc.cloudAgentNext = cloudAgentNext;
  mocks.trpc.organizations = {
    cloudAgentNext: {
      getPendingInteractions: organizationGetPendingInteractions,
      answerPermission: organizationAnswerPermission,
      prepareSession,
      listBitbucketRepositories,
    },
  };
  return {
    activeSessions,
    cliSessionsV2,
    getPendingInteractions,
    answerPermission,
    organizationGetPendingInteractions,
    organizationAnswerPermission,
    prepareSession,
  };
}

function collectSink() {
  const snapshots: GlanceableAgentsSnapshot[] = [];
  const sink: GlanceableSink = {
    publish: snapshot => {
      snapshots.push(snapshot);
    },
    startOrUpdate: () => undefined,
    endImmediate: () => undefined,
  };
  registerGlanceableSink(sink);
  return {
    snapshots,
    release: () => {
      unregisterGlanceableSink(sink);
    },
  };
}

describe('resolveWaitingSession', () => {
  it('returns null when nothing is in an attention status', () => {
    expect(
      resolveWaitingSession([
        { id: 'a', status: 'busy' },
        { id: 'b', status: 'retry' },
        { id: 'c', status: 'idle' },
      ])
    ).toBeNull();
  });

  it('returns the only permission/question row', () => {
    const waiting = resolveWaitingSession([
      { id: 'busy', status: 'busy' },
      { id: 'waiting', status: 'permission' },
    ]);
    expect(waiting?.id).toBe('waiting');
  });

  it('ranks by statusUpdatedAt and then createdAt, oldest first', () => {
    const waiting = resolveWaitingSession([
      { id: 'newer', status: 'question', statusUpdatedAt: '2026-01-05T00:00:00.000Z' },
      { id: 'older', status: 'permission', statusUpdatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'oldest', status: 'question', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(waiting?.id).toBe('oldest');
  });

  it('ranks a timed wait above one that carries no timestamp', () => {
    const waiting = resolveWaitingSession([
      { id: 'untimed', status: 'question' },
      { id: 'timed', status: 'permission', statusUpdatedAt: '2026-01-06T00:00:00.000Z' },
    ]);
    expect(waiting?.id).toBe('timed');
  });

  it('keeps the earlier row when two waits are equally old', () => {
    const waiting = resolveWaitingSession([
      { id: 'first', status: 'question', statusUpdatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'second', status: 'permission', statusUpdatedAt: '2026-01-02T00:00:00.000Z' },
    ]);
    expect(waiting?.id).toBe('first');
  });
});

describe('oldestPendingPermissionId', () => {
  it('returns the first permission carrying a usable id', () => {
    expect(
      oldestPendingPermissionId([
        { id: 'perm-1', tool: 'bash' },
        { id: 'perm-2', tool: 'edit' },
      ])
    ).toBe('perm-1');
  });

  it('skips entries the wire schema cannot describe', () => {
    expect(oldestPendingPermissionId([null, 'nope', { id: '' }, { id: 4 }, { id: 'perm-9' }])).toBe(
      'perm-9'
    );
  });

  it('returns null when nothing carries an id', () => {
    expect(oldestPendingPermissionId([])).toBeNull();
    expect(oldestPendingPermissionId([{ tool: 'bash' }])).toBeNull();
  });
});

describe('runningFeedback', () => {
  it('names the progress line of each in-place action', () => {
    expect(runningFeedback('approve')).toBe('approving');
    expect(runningFeedback('new-agent')).toBe('starting');
  });
});

describe('failureFeedback', () => {
  it('names the retry line of each in-place action', () => {
    expect(failureFeedback('approve')).toBe('couldNotApprove');
    expect(failureFeedback('new-agent')).toBe('couldNotStart');
  });
});

describe('runWidgetAction', () => {
  beforeEach(() => {
    mocks.secure.clear();
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.loadDraft.mockReset();
    mocks.clearDraft.mockReset();
    // A clear that succeeds: the failure cases override it per test.
    mocks.clearDraft.mockResolvedValue(true);
    mocks.blankEpoch = 0;
    mocks.orgLost = false;
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

  afterEach(() => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

  it('reports none when the tray holds no waiting session', async () => {
    wireTrpc({ sessions: [{ id: 'busy', status: 'busy' }] });

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'none' });
  });

  it('reports failed, not a rejection, when the stored scope cannot be read', async () => {
    wireTrpc({ sessions: [{ id: 'waiting', status: 'permission' }] });
    vi.mocked(readStoredValue).mockRejectedValueOnce(new Error('keychain locked'));

    // A rejected read used to escape the container and leave the widget on its
    // progress line, because nothing settled the action's own line.
    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'failed' });
  });

  it('does not republish when a terminal blank lands while the action runs', async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }],
    });
    rpc.answerPermission.mutate.mockImplementation(async () => {
      // The user signs out (or the org list drops the selection) while the
      // answer is in flight: the blank owns the surface from here on, exactly
      // as it owns the publisher.
      await Promise.resolve();
      mocks.blankEpoch += 1;
      return { success: true };
    });
    const { snapshots, release } = collectSink();

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'approved' });
    expect(snapshots).toEqual([]);
    release();
  });

  it('does not republish while a confirmed lost org blocks publication', async () => {
    wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }],
    });
    mocks.orgLost = true;
    const { snapshots, release } = collectSink();

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'approved' });
    expect(snapshots).toEqual([]);
    release();
  });

  it("reports the action's own result when the republish fails", async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }],
    });
    // The approve landed; the tray read its redraw needs is what fails.
    rpc.activeSessions.list.query
      .mockResolvedValueOnce({ sessions: [{ id: 'waiting', status: 'permission' }] })
      .mockRejectedValueOnce(new Error('tray down'));

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'approved' });
  });

  it('reports none when the waiting session is not a cloud-agent session', async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: null,
    });

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'none' });
    expect(rpc.getPendingInteractions.query).not.toHaveBeenCalled();
  });

  it('approves the oldest pending permission once and republishes the tray', async () => {
    const rpc = wireTrpc({
      sessions: [
        { id: 'busy', status: 'busy' },
        { id: 'waiting', status: 'permission' },
      ],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }, { id: 'perm-2' }],
    });
    const { snapshots, release } = collectSink();

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'approved' });

    expect(rpc.getPendingInteractions.query).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_agent_1',
    });
    expect(rpc.answerPermission.mutate).toHaveBeenCalledWith({
      sessionId: 'workspace_agent_1',
      permissionId: 'perm-1',
      response: 'once',
    });
    // The redraw reads the tray again: the approved wait is gone.
    expect(rpc.activeSessions.list.query).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ needsInput: 1, status: 'happy' });
    release();
  });

  it('reports no-permission when the wait asks a free-form question', async () => {
    wireTrpc({
      sessions: [{ id: 'waiting', status: 'question' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [],
    });

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'no-permission' });
  });

  // The chip is offered on `needsApproval`, which counts `permission` rows, so
  // the press must answer one of them: an older `question` must not shadow the
  // permission and turn the press into an open-the-app, and an older `retry`
  // must not displace it either.
  it.each(['question', 'retry'] as const)(
    'approves the waiting permission when an older %s waits beside it',
    async status => {
      const rpc = wireTrpc({
        sessions: [
          { id: 'older', status, statusUpdatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'waiting', status: 'permission', statusUpdatedAt: '2026-01-02T00:00:00.000Z' },
        ],
        cloudAgentSessionId: 'workspace_agent_1',
        permissions: [{ id: 'perm-1' }],
      });

      await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'approved' });

      expect(rpc.cliSessionsV2.get.query).toHaveBeenCalledWith({ session_id: 'waiting' });
      expect(rpc.answerPermission.mutate).toHaveBeenCalledWith({
        sessionId: 'workspace_agent_1',
        permissionId: 'perm-1',
        response: 'once',
      });
    }
  );

  it('reports failed when the answer is rejected, and publishes nothing', async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }],
    });
    rpc.answerPermission.mutate.mockRejectedValueOnce(new Error('network'));
    const { snapshots, release } = collectSink();

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'failed' });
    expect(snapshots).toEqual([]);
    release();
  });

  it('uses the organization-scoped procedures when an organization is selected', async () => {
    mocks.secure.set(ORGANIZATION_KEY, 'org-1');
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }],
    });

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'approved' });

    expect(rpc.activeSessions.list.query).toHaveBeenCalledWith({
      organizationId: 'org-1',
      includeCloudAgentSessions: true,
    });
    // The personal read refuses an organization session, so the organization
    // twin must serve it; the personal one must never be called.
    expect(rpc.organizationGetPendingInteractions.query).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_agent_1',
      organizationId: 'org-1',
    });
    expect(rpc.getPendingInteractions.query).not.toHaveBeenCalled();
    expect(rpc.organizationAnswerPermission.mutate).toHaveBeenCalledWith({
      sessionId: 'workspace_agent_1',
      permissionId: 'perm-1',
      response: 'once',
      organizationId: 'org-1',
    });
    expect(rpc.answerPermission.mutate).not.toHaveBeenCalled();
  });

  it('reads pending interactions through the personal procedure without an organization', async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }],
    });

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'approved' });

    expect(rpc.getPendingInteractions.query).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_agent_1',
    });
    expect(rpc.organizationGetPendingInteractions.query).not.toHaveBeenCalled();
  });

  it('reports none when there is no draft to start from', async () => {
    wireTrpc({});
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.loadDraft.mockResolvedValue('   ');

    await expect(runWidgetAction('new-agent')).resolves.toEqual({ kind: 'none' });
  });

  it('reports none when no model is stored for the scope', async () => {
    wireTrpc({});
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.loadDraft.mockResolvedValue('Ship the widget');

    await expect(runWidgetAction('new-agent')).resolves.toEqual({ kind: 'none' });
  });

  it('creates a session from the draft and clears it', async () => {
    const rpc = wireTrpc({});
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.secure.set(MODEL_KEY, JSON.stringify({ personal: { model: 'claude', variant: 'high' } }));
    mocks.loadDraft.mockResolvedValue('Ship the widget');

    await expect(runWidgetAction('new-agent')).resolves.toEqual({ kind: 'created' });

    expect(mocks.loadDraft).toHaveBeenCalledWith('user-1', DRAFT_KEY, expect.any(Function));
    expect(rpc.prepareSession.mutate).toHaveBeenCalledWith({
      prompt: 'Ship the widget',
      initialMessageId: expect.any(String),
      mode: 'code',
      model: 'claude',
      variant: 'high',
      autoCommit: false,
      autoInitiate: true,
      operationKey: '00000000-0000-4000-8000-000000000000',
      githubRepo: 'acme/widgets',
    });
    expect(mocks.clearDraft).toHaveBeenCalledWith('user-1', DRAFT_KEY);
  });

  it('clears the draft again when the first clear fails', async () => {
    wireTrpc({});
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.secure.set(MODEL_KEY, JSON.stringify({ personal: { model: 'claude', variant: 'high' } }));
    mocks.loadDraft.mockResolvedValue('Ship the widget');
    mocks.clearDraft.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    // A surviving draft would let the next New agent press start the same
    // prompt a second time, so the false result must not be dropped.
    await expect(runWidgetAction('new-agent')).resolves.toEqual({ kind: 'created' });
    expect(mocks.clearDraft).toHaveBeenCalledTimes(2);
  });

  it('still reports created when the draft cannot be cleared', async () => {
    wireTrpc({});
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.secure.set(MODEL_KEY, JSON.stringify({ personal: { model: 'claude', variant: 'high' } }));
    mocks.loadDraft.mockResolvedValue('Ship the widget');
    mocks.clearDraft.mockResolvedValue(false);

    // The session exists: the widget must not answer it with the failed-action
    // copy just because the draft's removal failed.
    await expect(runWidgetAction('new-agent')).resolves.toEqual({ kind: 'created' });
    expect(mocks.clearDraft).toHaveBeenCalledTimes(2);
  });

  it('reports none when the only recent repository is not on a known provider', async () => {
    const rpc = wireTrpc({});
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.secure.set(MODEL_KEY, JSON.stringify({ personal: { model: 'claude', variant: '' } }));
    mocks.loadDraft.mockResolvedValue('Ship the widget');
    (rpc.cliSessionsV2.recentRepositories.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      repositories: [{ gitUrl: 'https://example.com/acme/widgets.git' }],
    });

    await expect(runWidgetAction('new-agent')).resolves.toEqual({ kind: 'none' });
    expect(rpc.prepareSession.mutate).not.toHaveBeenCalled();
  });
});
