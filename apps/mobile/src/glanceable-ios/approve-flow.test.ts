/* eslint-disable require-await -- every injected double stands in for an async I/O dep, so it is async by contract with nothing to await. */
import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { type LiveSessionManagerHandle } from '@/components/agents/live-session-manager-registry';
import { approveFrontAgent, type FrontApprovalDeps } from '@/lib/glanceable/approve-front-agent';
import { type FrontApprovableRow } from '@/lib/glanceable/front-approval';

import { APPROVE_TARGET, type GlanceableUserInteraction } from './approve-action';
import { buildGlanceableLiveActivityContentState } from './view-props';

/**
 * The Live Activity card a waiting agent raises on the Lock Screen, and the
 * Approve path the app exposes for it, proved as one chain:
 *
 * a `permission` session row → the snapshot the sink pushes → the content state
 * the card renders (the wait count and the approvable count that gates the
 * Approve control) → a native interaction event delivered exactly as the widget
 * process delivers it → the real front-approval service answers the wait and
 * republishes the surfaces with the count dropped.
 *
 * The native surfaces themselves (and the wrist tap the simulator cannot
 * deliver) are unreachable here: this pins the JavaScript contract those
 * surfaces drive.
 */

type InteractionListener = (event: GlanceableUserInteraction) => void;

const mocks = vi.hoisted(() => ({
  listeners: [] as InteractionListener[],
  remove: vi.fn(),
}));

// The native surface is unreachable under vitest, so the expo-widgets
// subscription is the boundary under test: the module's handler is real, and
// the listener it registers is what a real press would reach.
vi.mock('expo-widgets', () => ({
  addUserInteractionListener: (listener: InteractionListener) => {
    mocks.listeners.push(listener);
    return { remove: mocks.remove };
  },
}));

const NOW = Date.parse('2026-01-02T00:00:00Z');

/** The waiting agent: a permission prompt, the only approvable wait. */
const WAITING_PERMISSION: FrontApprovableRow = {
  id: 'session-1',
  status: 'permission',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
};

/** The same session once the approval landed: no longer waiting on the user. */
const APPROVED: FrontApprovableRow = {
  ...WAITING_PERMISSION,
  status: 'busy',
  statusUpdatedAt: '2026-01-02T00:00:00.000Z',
};

/**
 * The native event's `source` is the ActivityKit instance id, not the Live
 * Activity's registration name: `WidgetLiveActivity.swift` renders the layout
 * with `name: context.activityID` and `DynamicView.swift` copies that name onto
 * the button's `source`.
 */
const NATIVE_ACTIVITY_ID = '8E1D4C0A-3F6B-4A1E-9C4D-7B2F0A5E9D31';

function snapshotOf(rows: readonly FrontApprovableRow[]): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions: rows,
    userId: 'user-1',
    organizationId: 'org-1',
    now: NOW,
  });
}

/** A manager that stands in for the open agent-chat screen's connection. */
function makeManager() {
  return {
    destroy: vi.fn<(handle: unknown) => void>(),
    respondToPermission: vi.fn(async (_requestId: string, _response: string) => undefined),
    switchSession: vi.fn(async (_sessionId: string) => undefined),
  };
}

/**
 * The approval flow with the open screen holding the session: the scope read,
 * the active-sessions list, and the refresh the service performs after the
 * response. The first list read is the front-approval pick; the refresh
 * re-reads, so the republished count is the post-approval one.
 */
function createFlow() {
  const manager = makeManager();
  const ackSessionAttention = vi.fn<(kiloSessionId: string) => void>();
  const refreshed: GlanceableAgentsSnapshot[] = [];
  const handle = { manager, store: createStore() } as unknown as LiveSessionManagerHandle;
  let listCalls = 0;
  const deps: FrontApprovalDeps = {
    getScope: async () => ({ organizationId: 'org-1', userId: 'user-1' }),
    listSessions: async () => {
      listCalls += 1;
      return listCalls === 1 ? [WAITING_PERMISSION] : [APPROVED];
    },
    getLiveSessionManager: () => handle,
    createLiveSessionManager: async () => {
      throw new Error('the open screen already holds this session');
    },
    destroyLiveSessionManager: vi.fn<(manager: LiveSessionManagerHandle) => void>(),
    ackSessionAttention,
    refreshGlanceableSurfaces: async ({ rows, scope, now }) => {
      refreshed.push(
        buildGlanceableSnapshot({
          sessions: rows,
          userId: scope.userId ?? 'user-1',
          organizationId: scope.organizationId,
          now,
        })
      );
    },
    readPendingAsks: () => [{ requestId: 'perm-9' }],
    isSessionStillWaiting: () => true,
    classifyFailure: () => 'retryable',
    now: () => NOW,
    sleep: async () => undefined,
  };
  return { deps, manager, ackSessionAttention, refreshed };
}

/**
 * Register `approve` the way `register.ts` registers the front-approval
 * service, and hand back the listener a native press reaches. A fresh module
 * graph per call: the listener and its callback are module state in
 * `approve-action`, and `vi.resetModules()` is the only way back to the
 * unregistered state the app boots in.
 */
async function loadApproveListener(approve: () => Promise<void>): Promise<InteractionListener> {
  vi.resetModules();
  mocks.listeners.length = 0;
  const { registerGlanceableApproveAction } = await import('./approve-action');
  const unsubscribe = registerGlanceableApproveAction(approve);
  expect(unsubscribe).toBeTypeOf('function');
  const listener = mocks.listeners[0];
  if (listener === undefined) {
    throw new Error('the approve action did not subscribe');
  }
  return listener;
}

describe('the Live Activity card for a waiting agent and its Approve path', () => {
  it('carries the wait count and the approvable count the Approve control is gated on', () => {
    const contentState = buildGlanceableLiveActivityContentState(snapshotOf([WAITING_PERMISSION]));
    // One waiting agent, and its wait is approvable without choosing an option,
    // so the card draws the needs-input row and the Approve control beside it.
    expect(contentState.needsInput).toBe(1);
    expect(contentState.needsApproval).toBe(1);
    expect(contentState.needsInputSince).toBe(WAITING_PERMISSION.statusUpdatedAt);
  });

  it('answers the front waiting permission once when the card reports an approve press', async () => {
    const flow = createFlow();
    const listener = await loadApproveListener(async () => {
      await approveFrontAgent(flow.deps);
    });

    listener({ source: NATIVE_ACTIVITY_ID, target: APPROVE_TARGET });

    await vi.waitFor(() => {
      expect(flow.manager.respondToPermission).toHaveBeenCalledWith('perm-9', 'once');
    });
    // The same ack the phone's permission card performs, and no second attach:
    // the open screen's connection owns the session.
    expect(flow.ackSessionAttention).toHaveBeenCalledWith('session-1');
    expect(flow.manager.switchSession).not.toHaveBeenCalled();

    // The republished frame is the post-approval one, so the card's count drops
    // without waiting for the background push.
    const frame = flow.refreshed[0];
    if (frame === undefined) {
      throw new Error('the approval did not republish the surfaces');
    }
    const contentState = buildGlanceableLiveActivityContentState(frame);
    expect(contentState.needsInput).toBe(0);
    expect(contentState.needsApproval).toBe(0);
  });

  it('leaves the wait untouched when the press is not the Approve control', async () => {
    const flow = createFlow();
    const listener = await loadApproveListener(async () => {
      await approveFrontAgent(flow.deps);
    });

    listener({ source: NATIVE_ACTIVITY_ID, target: 'open' });

    await vi.waitFor(() => {
      expect(flow.refreshed).toHaveLength(0);
    });
    expect(flow.manager.respondToPermission).not.toHaveBeenCalled();
    expect(flow.ackSessionAttention).not.toHaveBeenCalled();
  });
});
