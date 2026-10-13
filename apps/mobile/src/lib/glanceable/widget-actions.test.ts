/* eslint-disable max-lines -- one cohesive headless-action suite sharing the trpcClient harness */
// eslint-disable-next-line import/no-nodejs-modules -- test-only SHA-256 reference for the native digest
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { readStoredValue } from '@/lib/auth/secure-store-value';
import { __resetSessionAttentionForTests, isAttentionAcked } from '@/lib/session-attention';

import {
  type GlanceableSink,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from './sink-registry';
import { setSurfaceExtras } from './surface-extras';
import { resolveWaitingSession, runWidgetApprove, type WaitingSessionRow } from './widget-actions';

const ORGANIZATION_KEY = 'selected-organization';
const USER_KEY = 'active-user-id';

const mocks = vi.hoisted(() => {
  const trpc: Record<string, unknown> = {};
  return {
    secure: new Map<string, string>(),
    trpc,
    // The raise's app-owned notification, retired by an approve. Mocked because
    // the real module loads expo-notifications, which this pure suite cannot.
    dismissNeedsInputNotification: vi.fn(),
    // The publication gate `lib/glanceable/cleanup` owns: a terminal blank bump
    // and the lost-org latch, driven per case.
    blankEpoch: 0,
    orgLost: false,
  };
});

vi.mock('@/lib/needs-input-notification', () => ({
  dismissNeedsInputNotification: mocks.dismissNeedsInputNotification,
}));

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

vi.mock('@/lib/trpc', () => ({ trpcClient: mocks.trpc }));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: vi.fn(async (_algorithm: string, value: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }),
}));

/** The key a widget carries for the request it displayed. */
function keyFor(sessionId: string, permissionId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, permissionId]))
    .digest('hex');
}

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
}) {
  const activeSessions = { list: query({ sessions: options.sessions ?? [] }) };
  const cliSessionsV2 = {
    get: query({ cloud_agent_session_id: options.cloudAgentSessionId ?? null }),
  };
  const getPendingInteractions = query({
    questions: [],
    permissions: options.permissions ?? [],
  });
  const answerPermission = mutate({ success: true });
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
  };
  mocks.trpc.activeSessions = activeSessions;
  mocks.trpc.cliSessionsV2 = cliSessionsV2;
  mocks.trpc.cloudAgentNext = cloudAgentNext;
  mocks.trpc.organizations = {
    cloudAgentNext: {
      getPendingInteractions: organizationGetPendingInteractions,
      answerPermission: organizationAnswerPermission,
    },
  };
  return {
    activeSessions,
    cliSessionsV2,
    getPendingInteractions,
    answerPermission,
    organizationGetPendingInteractions,
    organizationAnswerPermission,
  };
}

function collectSink() {
  const snapshots: GlanceableAgentsSnapshot[] = [];
  // The start/update write, which is what raises the ongoing card in a fresh
  // headless process: a republish that only published would leave the shade on
  // the pre-action snapshot.
  const started: GlanceableAgentsSnapshot[] = [];
  const sink: GlanceableSink = {
    publish: snapshot => {
      snapshots.push(snapshot);
    },
    startOrUpdate: snapshot => {
      started.push(snapshot);
    },
    endImmediate: () => undefined,
  };
  registerGlanceableSink(sink);
  return {
    snapshots,
    started,
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

describe('runWidgetApprove', () => {
  beforeEach(() => {
    mocks.secure.clear();
    mocks.secure.set(USER_KEY, 'user-1');
    mocks.dismissNeedsInputNotification.mockReset();
    mocks.blankEpoch = 0;
    mocks.orgLost = false;
    // An approve records the same session-attention ack the other answer paths
    // do, and the store is module-level: drop it so one case's answer cannot
    // resolve another case's raise.
    __resetSessionAttentionForTests();
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

  afterEach(() => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

  it('reports none when the tray holds no waiting session', async () => {
    wireTrpc({ sessions: [{ id: 'busy', status: 'busy' }] });

    await expect(runWidgetApprove(null)).resolves.toEqual({ kind: 'none' });
  });

  it('reports failed, not a rejection, when the stored scope cannot be read', async () => {
    wireTrpc({ sessions: [{ id: 'waiting', status: 'permission' }] });
    vi.mocked(readStoredValue).mockRejectedValueOnce(new Error('keychain locked'));

    // A rejected read used to escape the container and leave the widget on its
    // progress line, because nothing settled the action's own line.
    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'failed',
    });
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

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'approved',
    });
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

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'approved',
    });
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

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'approved',
    });
  });

  it('answers nothing when the displayed session is not a cloud-agent session', async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: null,
    });

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({ kind: 'stale' });
    expect(rpc.getPendingInteractions.query).not.toHaveBeenCalled();
  });

  it('approves the displayed permission once and republishes the tray', async () => {
    const rpc = wireTrpc({
      sessions: [
        { id: 'busy', status: 'busy' },
        { id: 'waiting', status: 'permission' },
      ],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }, { id: 'perm-2' }],
    });
    const { snapshots, started, release } = collectSink();

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'approved',
    });

    expect(rpc.getPendingInteractions.query).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_agent_1',
    });
    expect(rpc.answerPermission.mutate).toHaveBeenCalledWith({
      sessionId: 'workspace_agent_1',
      permissionId: 'perm-1',
      response: 'once',
    });
    // The redraw reads the tray again: the approved wait is gone. The fixture
    // still reports the row as `permission` — `cli_sessions_v2.status` syncs
    // asynchronously after an answer — so the ack the press recorded is what
    // makes the redraw count it as answered instead of showing the pre-action
    // counts.
    expect(rpc.activeSessions.list.query).toHaveBeenCalledTimes(2);
    expect(isAttentionAcked('waiting', 'permission')).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ needsInput: 0, status: 'happy' });
    // The card outlives the JS process, so the republish must start/update it,
    // not only publish: a bare publish leaves a fresh headless process's shade
    // on the pre-action snapshot.
    expect(started).toEqual(snapshots);
    // The answered raise's app-owned notification goes with it: nothing else
    // retires it on this headless path.
    expect(mocks.dismissNeedsInputNotification).toHaveBeenCalledWith('waiting');
    release();
  });

  it('answers the displayed request, not merely the oldest one', async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }, { id: 'perm-2' }],
    });

    await expect(runWidgetApprove(keyFor('waiting', 'perm-2'))).resolves.toEqual({
      kind: 'approved',
    });
    expect(rpc.answerPermission.mutate).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'workspace_agent_1',
      permissionId: 'perm-2',
      response: 'once',
    });
  });

  it('reaches the request the server displayed past rows without a status time', async () => {
    // The server binds the key to the permission row with the earliest
    // `statusUpdatedAt`, rows without one last. Ranking these rows by their
    // older `createdAt` instead filled the bounded scan before the displayed
    // row and reported a live request as stale.
    const rpc = wireTrpc({
      sessions: [
        { id: 'untimed-1', status: 'permission', createdAt: '2025-01-01T00:00:00.000Z' },
        { id: 'untimed-2', status: 'permission', createdAt: '2025-01-02T00:00:00.000Z' },
        { id: 'untimed-3', status: 'permission', createdAt: '2025-01-03T00:00:00.000Z' },
        { id: 'newer', status: 'permission', statusUpdatedAt: '2026-01-03T00:00:00.000Z' },
        { id: 'front', status: 'permission', statusUpdatedAt: '2026-01-02T00:00:00.000Z' },
      ],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }],
    });

    await expect(runWidgetApprove(keyFor('front', 'perm-1'))).resolves.toEqual({
      kind: 'approved',
    });
    expect(rpc.cliSessionsV2.get.query).toHaveBeenCalledExactlyOnceWith({ session_id: 'front' });
    expect(rpc.answerPermission.mutate).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'workspace_agent_1',
      permissionId: 'perm-1',
      response: 'once',
    });
  });

  it('answers nothing for a stale press after the request was replaced', async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-2' }],
    });

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({ kind: 'stale' });
    expect(rpc.answerPermission.mutate).not.toHaveBeenCalled();
    expect(mocks.dismissNeedsInputNotification).not.toHaveBeenCalled();
  });

  it('leaves the raise notification alone when the approve never landed', async () => {
    const rpc = wireTrpc({
      sessions: [{ id: 'waiting', status: 'permission' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [{ id: 'perm-1' }],
    });
    rpc.answerPermission.mutate.mockRejectedValueOnce(new Error('network'));

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'failed',
    });
    expect(mocks.dismissNeedsInputNotification).not.toHaveBeenCalled();
  });

  it('reports no-permission when the wait asks a free-form question', async () => {
    wireTrpc({
      sessions: [{ id: 'waiting', status: 'question' }],
      cloudAgentSessionId: 'workspace_agent_1',
      permissions: [],
    });

    await expect(runWidgetApprove(null)).resolves.toEqual({ kind: 'no-permission' });
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

      await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
        kind: 'approved',
      });

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

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'failed',
    });
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

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'approved',
    });

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

    await expect(runWidgetApprove(keyFor('waiting', 'perm-1'))).resolves.toEqual({
      kind: 'approved',
    });

    expect(rpc.getPendingInteractions.query).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_agent_1',
    });
    expect(rpc.organizationGetPendingInteractions.query).not.toHaveBeenCalled();
  });
});
