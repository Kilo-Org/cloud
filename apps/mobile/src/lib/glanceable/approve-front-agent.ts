/* eslint-disable max-lines -- the injected-deps contract, the bounded ask wait, and the wired defaults stay together. */
import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  type KiloSessionId,
  type SessionManager,
  type UserWebConnection,
} from '@kilocode/cloud-agent-sdk';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';
import { type LiveSessionManagerHandle } from '@/components/agents/live-session-manager-registry';

import { type FrontApprovableRow, pickFrontApprovableSession } from './front-approval';
import { resolveAnsweredRaises } from './attention-rows';

/**
 * One waiting ask replayed by the wrapper. Only the id matters: the wrist
 * control always answers `once`, the same response the card's Allow Once sends.
 */
type FrontApprovalAsk = { requestId: string };

/** Bounded wait for the ask to replay on attach. */
const FRONT_APPROVAL_ASK_TIMEOUT_MS = 15_000;

/** Cadence of the bounded ask wait. */
const ASK_POLL_MS = 250;

/**
 * A not-yet-waiting manager must stay that way for this long before the ask is
 * called gone: a fresh attach resolves its metadata before the live transport
 * replays the pending request, so an immediate miss is not proof.
 */
const ASK_SETTLE_MS = 3000;

type FrontApprovalScope = {
  organizationId: string | null;
  userId: string | null;
};

export type FrontApprovalOutcome =
  | { kind: 'approved' }
  | { kind: 'nothing-to-approve' }
  /** The waiting row exists, but no ask is replayable on the session. */
  | { kind: 'request-gone' }
  | { kind: 'failed'; retryable: boolean };

/**
 * Every dependency of the approval, injected so the flow is unit-testable. The
 * defaults are wired in `defaultFrontApprovalDeps`.
 */
export type FrontApprovalDeps = {
  /** Selected organization id and active-user id, from the shared scope reads. */
  getScope(): Promise<FrontApprovalScope>;
  /** The same active-sessions list the glanceable snapshot is derived from. */
  listSessions(organizationId: string | null): Promise<readonly FrontApprovableRow[]>;
  /** The open screen's manager for this session, or null when it is not open. */
  getLiveSessionManager(sessionId: string): LiveSessionManagerHandle | null;
  /** A headless manager for a session no screen holds. The caller destroys it. */
  createLiveSessionManager(scope: FrontApprovalScope): Promise<LiveSessionManagerHandle>;
  /** Tear down a manager `createLiveSessionManager` made. Never a registered one. */
  destroyLiveSessionManager(handle: LiveSessionManagerHandle): void;
  /** The ack the permission card performs after a successful response. */
  ackSessionAttention(kiloSessionId: string): void;
  /** Publish fresh rows to the glanceable sinks through the push sink loop. */
  refreshGlanceableSurfaces(input: {
    rows: readonly FrontApprovableRow[];
    scope: FrontApprovalScope;
    now: number;
  }): Promise<void>;
  /** The asks the manager currently replays, oldest first. */
  readPendingAsks(handle: LiveSessionManagerHandle): readonly FrontApprovalAsk[];
  /** False once the session is attached, loaded, and waiting on nothing. */
  isSessionStillWaiting(handle: LiveSessionManagerHandle): boolean;
  /** Retryable transport failures vs a terminal rejection (the ask is gone). */
  classifyFailure(error: unknown): 'retryable' | 'terminal';
  now(): number;
  sleep(ms: number): Promise<void>;
  askTimeoutMs?: number;
  askPollMs?: number;
  askSettleMs?: number;
};

/**
 * Approve the agent the wrist control is aimed at: the longest-waiting session
 * whose status is `permission`. Answers through the open screen's connection
 * when it holds that session, otherwise attaches a headless one, waits for the
 * replayed ask, responds `once`, acks attention exactly like the card, and
 * republishes the surfaces from fresh rows.
 */
export async function approveFrontAgent(deps?: FrontApprovalDeps): Promise<FrontApprovalOutcome> {
  return runApproval(deps ?? (await defaultFrontApprovalDeps()));
}

async function runApproval(deps: FrontApprovalDeps): Promise<FrontApprovalOutcome> {
  let scope: FrontApprovalScope | null = null;
  let rows: readonly FrontApprovableRow[] = [];
  try {
    scope = await deps.getScope();
    rows = await deps.listSessions(scope.organizationId);
  } catch (error) {
    // The primary scope/list read is I/O the surface cannot see: it must map to
    // the documented outcome instead of rejecting. Refresh when the scope is
    // known so a control that outlived its ask still disappears.
    if (scope !== null) {
      await refreshSurfaces(deps, scope);
    }
    return { kind: 'failed', retryable: deps.classifyFailure(error) === 'retryable' };
  }
  const front = pickFrontApprovableSession(rows);
  if (front === null) {
    // Still refresh: a control that outlived its ask must disappear.
    await refreshSurfaces(deps, scope);
    return { kind: 'nothing-to-approve' };
  }

  let handle = deps.getLiveSessionManager(front.id);
  let created = false;
  if (handle === null) {
    try {
      handle = await deps.createLiveSessionManager(scope);
    } catch (error) {
      // The factory can reject after it has already retained a connection; it
      // owns that teardown. The failure must still map to an outcome and refresh
      // the surfaces instead of escaping this function.
      await refreshSurfaces(deps, scope);
      return { kind: 'failed', retryable: deps.classifyFailure(error) === 'retryable' };
    }
    created = true;
    try {
      // The active-sessions row id is the kilo session id the manager switches
      // on (the route brands the same value the same way).
      await handle.manager.switchSession(front.id as KiloSessionId);
    } catch (error) {
      destroyHeadless(deps, handle);
      await refreshSurfaces(deps, scope);
      return { kind: 'failed', retryable: deps.classifyFailure(error) === 'retryable' };
    }
  }

  let outcome: FrontApprovalOutcome = { kind: 'failed', retryable: true };
  try {
    outcome = await answerFrontAsk(deps, handle, front.id);
  } finally {
    // Only a manager this call created: a registered one belongs to the screen.
    if (created) {
      destroyHeadless(deps, handle);
    }
  }
  await refreshSurfaces(deps, scope);
  return outcome;
}

/**
 * Tear down a manager this call created.
 *
 * Teardown runs from the approval's `finally`, so a rejection here would skip
 * the surface refresh and replace the outcome with a failure the wrist cannot
 * show. The handle is dropped either way, so a failed teardown has nothing left
 * to act on.
 */
function destroyHeadless(deps: FrontApprovalDeps, handle: LiveSessionManagerHandle): void {
  try {
    deps.destroyLiveSessionManager(handle);
  } catch {
    // Deliberate: see above.
  }
}

async function answerFrontAsk(
  deps: FrontApprovalDeps,
  handle: LiveSessionManagerHandle,
  kiloSessionId: string
): Promise<FrontApprovalOutcome> {
  const wait = await waitForAsk(deps, handle);
  if (wait.kind === 'timeout') {
    // The ask never replayed while the row still waited: a transport stall the
    // user can retry, not a rejection.
    return { kind: 'failed', retryable: true };
  }
  if (wait.kind === 'gone') {
    return { kind: 'request-gone' };
  }
  try {
    await handle.manager.respondToPermission(wait.requestId, 'once');
  } catch (error) {
    return { kind: 'failed', retryable: deps.classifyFailure(error) === 'retryable' };
  }
  // The same ack the permission card performs once the wrapper accepted it.
  deps.ackSessionAttention(kiloSessionId);
  return { kind: 'approved' };
}

type AskWait = { kind: 'ask'; requestId: string } | { kind: 'gone' } | { kind: 'timeout' };

/** Re-read the replayed asks until one lands, the session stops waiting, or the bound. */
async function waitForAsk(
  deps: FrontApprovalDeps,
  handle: LiveSessionManagerHandle
): Promise<AskWait> {
  const deadline = deps.now() + (deps.askTimeoutMs ?? FRONT_APPROVAL_ASK_TIMEOUT_MS);
  const pollMs = deps.askPollMs ?? ASK_POLL_MS;
  const settleMs = deps.askSettleMs ?? ASK_SETTLE_MS;
  let notWaitingSince: number | null = null;
  for (;;) {
    const [ask] = deps.readPendingAsks(handle);
    if (ask !== undefined) {
      return { kind: 'ask', requestId: ask.requestId };
    }
    const now = deps.now();
    if (deps.isSessionStillWaiting(handle)) {
      notWaitingSince = null;
    } else {
      notWaitingSince ??= now;
      if (now - notWaitingSince >= settleMs) {
        return { kind: 'gone' };
      }
    }
    if (now >= deadline) {
      return { kind: 'timeout' };
    }
    // Polling is the contract: each read must land before the next sleep.
    // eslint-disable-next-line no-await-in-loop -- the bounded wait re-reads the ask between sleeps
    await deps.sleep(pollMs);
  }
}

/** Rebuild from fresh rows and hand the snapshot to the push sink loop. */
async function refreshSurfaces(deps: FrontApprovalDeps, scope: FrontApprovalScope): Promise<void> {
  try {
    const rows = await deps.listSessions(scope.organizationId);
    await deps.refreshGlanceableSurfaces({ rows, scope, now: deps.now() });
  } catch {
    // A failed refresh must not change the outcome: the next push republishes.
  }
}

/**
 * Rebuild the glanceable surfaces from the tray without approving anything.
 *
 * The needs-input notification's headless Approve/Reply runs with no screen
 * mounted: it acks the raise, and a surface already showing that raise must be
 * republished at once rather than waiting for the next push (a status-only
 * raise never produces one). Uses the same default deps as the wrist control's
 * refresh, so the ack resolution can never disagree with the tray it reads.
 */
export async function refreshGlanceableSurfacesFromTray(): Promise<void> {
  const deps = await defaultFrontApprovalDeps();
  const scope = await deps.getScope();
  await refreshSurfaces(deps, scope);
}

/** Connections created for headless managers, so teardown can close the socket. */
const headlessConnections = new Map<SessionManager, UserWebConnection>();

/**
 * The active-sessions list the picker reads. It must be the same tray list the
 * glanceable snapshot (and therefore the `needsApproval` count that gates the
 * wrist control) is derived from: the tray input opts into the cloud-agent
 * merge, so a cloud-agent permission row counts as approvable. A bare
 * `buildActiveSessionsInput` read would hide that row from the picker and leave
 * the control offering an Approve that always answers `nothing-to-approve`.
 */
export function frontApprovalListInput(organizationId: string | null | undefined) {
  return buildActiveSessionsTrayInput(organizationId);
}

async function defaultFrontApprovalDeps(): Promise<FrontApprovalDeps> {
  const { getActiveUserId, getSelectedOrganizationId } = await import('@/lib/glanceable/scope');
  const { trpcClient } = await import('@/lib/trpc');
  const { createStore } = await import('jotai');
  const { createMobileAgentSessionManager } =
    await import('@/components/agents/mobile-session-manager');
  const { createUserWebConnection } = await import('@kilocode/cloud-agent-sdk/user-web-connection');
  const { createNativeUserWebConnectionLifecycleHooks } =
    await import('@/lib/user-web-connection-lifecycle');
  const { SESSION_INGEST_WS_URL } = await import('@/lib/config');
  const { getLiveSessionManager } =
    await import('@/components/agents/live-session-manager-registry');
  const { ackSessionAttention } = await import('@/lib/session-attention');
  const { applyGlanceablePushData } = await import('@/lib/notifications');
  const { restorePersistedGlanceable } = await import('@/lib/glanceable/persist');
  const { getActiveToken } = await import('@/lib/auth/token-owner');
  const { confirmAuthenticatedOwner, getAuthenticatedOwner, isCurrentOwner } =
    await import('@/lib/context-scope');

  return {
    getScope: async () => ({
      organizationId: await getSelectedOrganizationId(),
      userId: await getActiveUserId(),
    }),
    listSessions: async organizationId => {
      const response = await trpcClient.activeSessions.list.query(
        frontApprovalListInput(organizationId)
      );
      return response.sessions;
    },
    getLiveSessionManager,
    // eslint-disable-next-line require-await -- async by contract: its awaits live in getAuthToken
    createLiveSessionManager: async approvalScope => {
      const store = createStore();
      // The same connection shape the open screen builds
      // (`user-web-connection-provider.tsx`), including its owner fencing: the
      // ticket must never be minted for an account that changed mid-attach.
      const captured = getAuthenticatedOwner();
      const connection = createUserWebConnection({
        websocketUrl: `${SESSION_INGEST_WS_URL}/api/user/web`,
        getAuthToken: async () => {
          if (!isCurrentOwner(captured) || !getActiveToken()) {
            throw new Error('Authenticated owner changed');
          }
          if (getAuthenticatedOwner().userId === null) {
            const user = await trpcClient.user.getMe.query();
            if (!confirmAuthenticatedOwner(captured, user.id)) {
              throw new Error('Authenticated owner changed');
            }
          }
          if (!isCurrentOwner(captured)) {
            throw new Error('Authenticated owner changed');
          }
          const result = await trpcClient.activeSessions.createWebTicket.mutate();
          if (!isCurrentOwner(captured)) {
            throw new Error('Authenticated owner changed');
          }
          return result.token;
        },
        lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
      });
      // Without a retain the connection never opens: `hasLifetime()` is false.
      // The release handle is not kept: teardown destroys the connection.
      connection.retain();
      try {
        const manager = createMobileAgentSessionManager({
          store,
          userWebConnection: connection,
          organizationId: approvalScope.organizationId ?? undefined,
        });
        headlessConnections.set(manager, connection);
        return { manager, store };
      } catch (error) {
        // A manager that never comes back would strand the retained socket: the
        // map entry is the only handle a later teardown has.
        connection.destroy();
        throw error;
      }
    },
    destroyLiveSessionManager: handle => {
      // Drop the map entry before the manager's own teardown runs: it is the
      // only handle to the retained socket, so a throwing teardown would
      // otherwise leak the connection.
      const connection = headlessConnections.get(handle.manager);
      if (connection !== undefined) {
        headlessConnections.delete(handle.manager);
        connection.destroy();
      }
      try {
        handle.manager.destroy();
      } catch {
        // Teardown is best-effort: nothing downstream can act on a failure, and
        // the approval's own refresh must still run.
      }
    },
    ackSessionAttention,
    refreshGlanceableSurfaces: async ({ rows, scope: surfaceScope, now }) => {
      if (surfaceScope.userId === null) {
        // No confirmed account: the push fence would reject the snapshot, so
        // there is nothing honest to publish.
        return;
      }
      // A freshly launched (headless) process has no in-memory fence yet; the
      // persisted one is what every pushed snapshot is fenced against.
      await restorePersistedGlanceable();
      const snapshot = buildGlanceableSnapshot({
        // A raise the user answered from the needs-input notification is no
        // longer waiting: count it the way the in-app list does, or the
        // republished surface contradicts the result notification.
        sessions: resolveAnsweredRaises(rows),
        userId: surfaceScope.userId,
        organizationId: surfaceScope.organizationId,
        now,
      });
      await applyGlanceablePushData({ type: 'active_agents_glanceable', ...snapshot });
    },
    readPendingAsks: handle => handle.store.get(handle.manager.atoms.pendingPermissions),
    isSessionStillWaiting: isManagerStillWaitingForApproval,
    classifyFailure: classifyFrontApprovalFailure,
    now: () => Date.now(),
    sleep: async ms => {
      await new Promise<void>(resolve => {
        setTimeout(resolve, ms);
      });
    },
  };
}

/** Retryable transport failures vs a terminal rejection the user cannot retry. */
export function classifyFrontApprovalFailure(error: unknown): 'retryable' | 'terminal' {
  return isTerminalTrpcCode(readTrpcErrorField(error, 'code')) ? 'terminal' : 'retryable';
}

/**
 * Whether the manager still shows this session blocked on a permission. A
 * pending permission is proof. So is an attach that has not finished: the
 * metadata load and the transport connect both precede the ask replay, and a
 * disconnected socket may still replay it.
 */
export function isManagerStillWaitingForApproval(handle: LiveSessionManagerHandle): boolean {
  const { manager, store } = handle;
  if (store.get(manager.atoms.pendingPermissions).length > 0) {
    return true;
  }
  if (store.get(manager.atoms.activePermission) !== null) {
    return true;
  }
  if (store.get(manager.atoms.isLoading)) {
    return true;
  }
  const activity = store.get(manager.atoms.activity);
  if (activity.type === 'connecting' || activity.type === 'retrying') {
    return true;
  }
  return store.get(manager.atoms.agentStatus).type === 'disconnected';
}
