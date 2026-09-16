/* eslint-disable max-lines -- one cohesive headless-action suite sharing the trpcClient harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  type GlanceableSink,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from './sink-registry';
import { setSurfaceExtras } from './surface-extras';
import {
  oldestPendingPermissionId,
  resolveWaitingSession,
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
  };
});

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return mocks.secure.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    mocks.secure.set(key, value);
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

describe('runWidgetAction', () => {
  beforeEach(() => {
    mocks.secure.clear();
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.loadDraft.mockReset();
    mocks.clearDraft.mockReset();
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

  afterEach(() => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

  it('reports none when the tray holds no waiting session', async () => {
    wireTrpc({ sessions: [{ id: 'busy', status: 'busy' }] });

    await expect(runWidgetAction('approve')).resolves.toEqual({ kind: 'none' });
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
