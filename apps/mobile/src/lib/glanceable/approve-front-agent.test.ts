/* eslint-disable max-lines, require-await -- every injected double stands in for an async I/O dep (async by contract, nothing to await), and the outcome branches from nothing-to-approve through every rejection stay together. */
import { atom, createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

import { type SessionManager } from '@kilocode/cloud-agent-sdk';

import { type LiveSessionManagerHandle } from '@/components/agents/live-session-manager-registry';

import {
  approveFrontAgent,
  classifyFrontApprovalFailure,
  type FrontApprovalDeps,
  frontApprovalListInput,
  isManagerStillWaitingForApproval,
} from './approve-front-agent';
import { type FrontApprovableRow } from './front-approval';

const PERMISSION_ROW: FrontApprovableRow = {
  id: 'session-1',
  status: 'permission',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
};
const BUSY_ROW: FrontApprovableRow = {
  id: 'session-1',
  status: 'busy',
  statusUpdatedAt: '2026-01-01T00:01:00.000Z',
};
const QUESTION_ROW: FrontApprovableRow = {
  id: 'session-2',
  status: 'question',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
};

type FakeManager = {
  destroy: ReturnType<typeof vi.fn>;
  respondToPermission: ReturnType<typeof vi.fn>;
  switchSession: ReturnType<typeof vi.fn>;
};

type FakeHandle = { manager: FakeManager; handle: LiveSessionManagerHandle };

function makeFakeHandle(options: {
  respondRejection?: unknown;
  switchRejection?: unknown;
}): FakeHandle {
  const manager: FakeManager = {
    destroy: vi.fn(),
    respondToPermission: vi.fn(async (_requestId: string, _response: string) => undefined),
    switchSession: vi.fn(async (_sessionId: string) => undefined),
  };
  if (options.respondRejection !== undefined) {
    manager.respondToPermission.mockRejectedValue(options.respondRejection);
  }
  if (options.switchRejection !== undefined) {
    manager.switchSession.mockRejectedValue(options.switchRejection);
  }
  return {
    manager,
    handle: { manager, store: createStore() } as unknown as LiveSessionManagerHandle,
  };
}

type HarnessInput = {
  /** Rows returned by the first (front-approval) list read. */
  rows: readonly FrontApprovableRow[];
  /** Rows returned by the refresh re-list; defaults to `rows`. */
  refreshedRows?: readonly FrontApprovableRow[];
  /** The manager the open screen registered, when it holds this session. */
  registered?: FakeHandle | null;
  pendingAsks?: readonly { requestId: string }[];
  stillWaiting?: boolean;
  refreshRejection?: Error;
  /** Rejection of the primary `activeSessions.list` read (the front-approval read). */
  listRejection?: Error;
  /** Rejection of the scope read that precedes the list read. */
  scopeRejection?: Error;
  /** Rejection of the headless manager factory, after it may have retained a connection. */
  createRejection?: Error;
  /** A failing teardown: the approval must still refresh and keep its outcome. */
  destroyRejection?: Error;
  askSettleMs?: number;
  headless?: { respondRejection?: unknown; switchRejection?: unknown };
};

function createHarness(input: HarnessInput) {
  const clock = { now: 1_000_000 };
  const headless = makeFakeHandle(input.headless ?? {});
  const destroyLiveSessionManager = vi.fn<(handle: LiveSessionManagerHandle) => void>(() => {
    if (input.destroyRejection !== undefined) {
      throw input.destroyRejection;
    }
  });
  const ackSessionAttention = vi.fn<(kiloSessionId: string) => void>();
  let listCall = 0;
  const listSessions = vi.fn(async (_organizationId: string | null) => {
    listCall += 1;
    if (input.listRejection !== undefined) {
      throw input.listRejection;
    }
    return listCall === 1 ? input.rows : (input.refreshedRows ?? input.rows);
  });
  const refreshGlanceableSurfaces = vi.fn(
    async (_input: {
      rows: readonly FrontApprovableRow[];
      scope: { organizationId: string | null; userId: string | null };
      now: number;
    }) => {
      if (input.refreshRejection !== undefined) {
        throw input.refreshRejection;
      }
    }
  );
  const deps: FrontApprovalDeps = {
    getScope: async () => {
      if (input.scopeRejection !== undefined) {
        throw input.scopeRejection;
      }
      return { organizationId: 'org-1', userId: 'user-1' };
    },
    listSessions,
    getLiveSessionManager: () => input.registered?.handle ?? null,
    createLiveSessionManager: async () => {
      if (input.createRejection !== undefined) {
        throw input.createRejection;
      }
      return headless.handle;
    },
    destroyLiveSessionManager,
    ackSessionAttention,
    refreshGlanceableSurfaces,
    readPendingAsks: () => input.pendingAsks ?? [],
    isSessionStillWaiting: () => input.stillWaiting ?? true,
    classifyFailure: classifyFrontApprovalFailure,
    now: () => clock.now,
    sleep: async ms => {
      clock.now += ms;
    },
    askSettleMs: input.askSettleMs ?? 0,
  };
  return {
    deps,
    headless,
    destroyLiveSessionManager,
    ackSessionAttention,
    refreshGlanceableSurfaces,
  };
}

function refreshedRows(harness: ReturnType<typeof createHarness>): unknown {
  return harness.refreshGlanceableSurfaces.mock.calls[0]?.[0].rows;
}

describe('approveFrontAgent', () => {
  it('answers once on the replayed ask, acks, and republishes fresh rows through the open connection', async () => {
    const registered = makeFakeHandle({});
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      refreshedRows: [BUSY_ROW],
      registered,
      pendingAsks: [{ requestId: 'perm-9' }],
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'approved' });
    expect(registered.manager.respondToPermission).toHaveBeenCalledWith('perm-9', 'once');
    // The relay allows one owner: the open screen's connection is reused, not
    // re-attached, and it is never destroyed by the approval.
    expect(registered.manager.switchSession).not.toHaveBeenCalled();
    expect(harness.destroyLiveSessionManager).not.toHaveBeenCalled();
    expect(harness.headless.manager.switchSession).not.toHaveBeenCalled();
    expect(harness.ackSessionAttention).toHaveBeenCalledWith('session-1');
    // The refresh carries the post-approval rows, so the count drops without
    // waiting for the background push.
    expect(refreshedRows(harness)).toEqual([BUSY_ROW]);
  });

  it('attaches a headless manager, switches it to the front session, and destroys it afterwards', async () => {
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      pendingAsks: [{ requestId: 'perm-2' }],
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'approved' });
    expect(harness.headless.manager.switchSession).toHaveBeenCalledWith('session-1');
    expect(harness.headless.manager.respondToPermission).toHaveBeenCalledWith('perm-2', 'once');
    expect(harness.destroyLiveSessionManager).toHaveBeenCalledTimes(1);
    expect(harness.ackSessionAttention).toHaveBeenCalledWith('session-1');
  });

  it('returns nothing-to-approve for a question-only front and still refreshes the surfaces', async () => {
    const harness = createHarness({ rows: [QUESTION_ROW], refreshedRows: [] });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'nothing-to-approve' });
    expect(harness.headless.manager.switchSession).not.toHaveBeenCalled();
    expect(harness.ackSessionAttention).not.toHaveBeenCalled();
    expect(refreshedRows(harness)).toEqual([]);
  });

  it('returns nothing-to-approve when no session waits and still refreshes the surfaces', async () => {
    const harness = createHarness({ rows: [] });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'nothing-to-approve' });
    expect(harness.refreshGlanceableSurfaces).toHaveBeenCalledTimes(1);
  });

  it('fails retryable when the ask never arrives before the bound', async () => {
    const harness = createHarness({ rows: [PERMISSION_ROW], pendingAsks: [], stillWaiting: true });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'failed', retryable: true });
    expect(harness.headless.manager.respondToPermission).not.toHaveBeenCalled();
    expect(harness.destroyLiveSessionManager).toHaveBeenCalledTimes(1);
    expect(harness.refreshGlanceableSurfaces).toHaveBeenCalledTimes(1);
  });

  it('fails retryable without rejecting when the active-sessions read rejects', async () => {
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      listRejection: new Error('network down'),
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'failed', retryable: true });
    expect(harness.headless.manager.switchSession).not.toHaveBeenCalled();
    expect(harness.ackSessionAttention).not.toHaveBeenCalled();
  });

  it('fails terminally without rejecting when the active-sessions read rejects terminally', async () => {
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      listRejection: Object.assign(new Error('session expired'), {
        data: { code: 'UNAUTHORIZED', message: 'session expired' },
      }),
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'failed', retryable: false });
    expect(harness.headless.manager.switchSession).not.toHaveBeenCalled();
  });

  it('fails retryable without rejecting when the scope read rejects', async () => {
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      scopeRejection: new Error('secure store unavailable'),
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'failed', retryable: true });
    expect(harness.headless.manager.switchSession).not.toHaveBeenCalled();
    expect(harness.ackSessionAttention).not.toHaveBeenCalled();
  });

  it('reports request-gone when the session stops waiting without replaying an ask', async () => {
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      pendingAsks: [],
      stillWaiting: false,
      askSettleMs: 0,
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'request-gone' });
    expect(harness.headless.manager.respondToPermission).not.toHaveBeenCalled();
    expect(harness.destroyLiveSessionManager).toHaveBeenCalledTimes(1);
  });

  it('holds the gone verdict until the attach had time to replay the ask', async () => {
    let read = 0;
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      stillWaiting: false,
      askSettleMs: 3000,
    });
    harness.deps.readPendingAsks = () => {
      read += 1;
      // The replay lands a few polls after the attach settled.
      return read > 4 ? [{ requestId: 'perm-late' }] : [];
    };

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'approved' });
    expect(harness.headless.manager.respondToPermission).toHaveBeenCalledWith('perm-late', 'once');
  });

  it('fails retryable when respond rejects with a transport error', async () => {
    const registered = makeFakeHandle({ respondRejection: new Error('socket closed') });
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      registered,
      pendingAsks: [{ requestId: 'perm-3' }],
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'failed', retryable: true });
    expect(harness.ackSessionAttention).not.toHaveBeenCalled();
  });

  it('fails terminally when respond rejects with not-found', async () => {
    const registered = makeFakeHandle({
      respondRejection: { data: { code: 'NOT_FOUND', message: 'gone' } },
    });
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      registered,
      pendingAsks: [{ requestId: 'perm-4' }],
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'failed', retryable: false });
  });

  it('fails retryable when the headless attach rejects', async () => {
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      headless: { switchRejection: new Error('no route') },
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'failed', retryable: true });
    expect(harness.destroyLiveSessionManager).toHaveBeenCalledTimes(1);
    expect(harness.refreshGlanceableSurfaces).toHaveBeenCalledTimes(1);
  });

  it('keeps the outcome when the surface refresh rejects', async () => {
    const registered = makeFakeHandle({});
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      registered,
      pendingAsks: [{ requestId: 'perm-5' }],
      refreshRejection: new Error('sink unavailable'),
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'approved' });
    expect(harness.ackSessionAttention).toHaveBeenCalledWith('session-1');
  });

  it('fails without rejecting when the headless manager factory rejects', async () => {
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      createRejection: new Error('connection refused'),
    });

    const outcome = await approveFrontAgent(harness.deps);

    expect(outcome).toEqual({ kind: 'failed', retryable: true });
    expect(harness.destroyLiveSessionManager).not.toHaveBeenCalled();
    // The factory rejects after it may have retained a connection. That
    // rejection must not escape and skip the republish, or a control that
    // outlived its ask would stay on the surface.
    expect(harness.refreshGlanceableSurfaces).toHaveBeenCalledTimes(1);
  });

  it('keeps the outcome and the refresh when the headless teardown rejects', async () => {
    const harness = createHarness({
      rows: [PERMISSION_ROW],
      pendingAsks: [{ requestId: 'perm-6' }],
      destroyRejection: new Error('destroy failed'),
    });

    const outcome = await approveFrontAgent(harness.deps);

    // Teardown runs from the approval's `finally`: a rejection there must not
    // replace the outcome or skip the surface refresh.
    expect(outcome).toEqual({ kind: 'approved' });
    expect(harness.destroyLiveSessionManager).toHaveBeenCalledTimes(1);
    expect(harness.refreshGlanceableSurfaces).toHaveBeenCalledTimes(1);
  });
});

describe('frontApprovalListInput', () => {
  it('reads the same cloud-inclusive tray list the glanceable snapshot is derived from', () => {
    // The `needsApproval` count that gates the wrist control is built from the
    // tray list, cloud-agent rows included; the picker must query that same
    // list or a cloud-agent permission row would offer an Approve the picker
    // cannot answer.
    expect(frontApprovalListInput('org-1')).toEqual({
      organizationId: 'org-1',
      includeCloudAgentSessions: true,
    });
  });

  it('keeps the cloud merge while collapsing an absent org context to personal', () => {
    expect(frontApprovalListInput(null)).toEqual({
      organizationId: null,
      includeCloudAgentSessions: true,
    });
    expect(frontApprovalListInput(undefined)).toEqual({
      organizationId: null,
      includeCloudAgentSessions: true,
    });
  });
});

describe('classifyFrontApprovalFailure', () => {
  it('treats a terminal tRPC code as terminal', () => {
    expect(classifyFrontApprovalFailure({ data: { code: 'NOT_FOUND' } })).toBe('terminal');
    expect(classifyFrontApprovalFailure({ shape: { data: { code: 'FORBIDDEN' } } })).toBe(
      'terminal'
    );
  });

  it('treats anything else as retryable', () => {
    expect(classifyFrontApprovalFailure(new Error('timeout'))).toBe('retryable');
    expect(classifyFrontApprovalFailure(undefined)).toBe('retryable');
  });
});

describe('isManagerStillWaitingForApproval', () => {
  function atomHandle() {
    const pendingPermissions = atom<readonly { requestId: string }[]>([]);
    const activePermission = atom<{ requestId: string } | null>(null);
    const isLoading = atom(false);
    const activity = atom<{ type: string }>({ type: 'idle' });
    const agentStatus = atom<{ type: string }>({ type: 'idle' });
    const store = createStore();
    const manager = {
      atoms: { pendingPermissions, activePermission, isLoading, activity, agentStatus },
    } as unknown as SessionManager;
    return {
      handle: { manager, store } as unknown as LiveSessionManagerHandle,
      store,
      pendingPermissions,
      isLoading,
      activity,
      agentStatus,
    };
  }

  it('is waiting while an ask is pending', () => {
    const fake = atomHandle();
    fake.store.set(fake.pendingPermissions, [{ requestId: 'perm-1' }]);

    expect(isManagerStillWaitingForApproval(fake.handle)).toBe(true);
  });

  it('keeps waiting while the attach has not finished', () => {
    const fake = atomHandle();
    fake.store.set(fake.isLoading, true);

    expect(isManagerStillWaitingForApproval(fake.handle)).toBe(true);
  });

  it('keeps waiting while the transport is still connecting', () => {
    const fake = atomHandle();
    fake.store.set(fake.activity, { type: 'connecting' });

    expect(isManagerStillWaitingForApproval(fake.handle)).toBe(true);
  });

  it('stops waiting once an attached session reports no ask', () => {
    const fake = atomHandle();
    fake.store.set(fake.agentStatus, { type: 'idle' });

    expect(isManagerStillWaitingForApproval(fake.handle)).toBe(false);
  });
});
