import type {
  ControlPlaneSessionPeer,
  ControlRuntimeCredentialProxyFence,
} from '../../../src/control-plane/sandbox/sandbox-do.js';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from '../../../src/runtime-credential-proxy.js';
import type {
  ControlPlaneEventsNotification,
  ControlPlaneOutcome,
  ControlPlaneRouteUpdate,
} from '../../../src/shared/control-plane-protocol.js';
import type { Env } from '../../../src/types.js';
import type { WorktreeChangesReady } from '../../../src/control-plane/worktree-changes-ready.js';

export type RecordedRouteUpdate = { sessionId: string; update: ControlPlaneRouteUpdate };
export type RecordedEvents = { sessionId: string; notification: ControlPlaneEventsNotification };

/**
 * A synthetic Session DO peer. The real V2 Session DO is B4, so the Sandbox DO
 * takes an injectable factory; this records what it received per session.
 */
export class FakeSessionPeer {
  readonly routeUpdates: RecordedRouteUpdate[] = [];
  readonly events: RecordedEvents[] = [];
  readonly outcomes: ControlPlaneOutcome[] = [];
  readonly worktreeChanges: Array<{ sessionId: string; notification: WorktreeChangesReady }> = [];
  /** Every notification in arrival order, across kinds. */
  readonly received: Array<{
    kind: 'route' | 'events' | 'outcome' | 'worktree_changes';
    sessionId: string;
  }> = [];
  /** Delegation expiry this peer reports, so handoff selection is controllable. */
  delegationExpiresAt: number | null = null;

  forSession(sessionId: string): ControlPlaneSessionPeer {
    return {
      onRoute: async update => {
        this.received.push({ kind: 'route', sessionId });
        this.routeUpdates.push({ sessionId, update });
      },
      onEvents: async notification => {
        this.received.push({ kind: 'events', sessionId });
        this.events.push({ sessionId, notification });
      },
      onOutcome: async outcome => {
        this.received.push({ kind: 'outcome', sessionId });
        this.outcomes.push(outcome);
      },
      getRuntimeProxyDelegationExpiresAt: async () => this.delegationExpiresAt,
      onWorktreeChangesReady: async notification => {
        this.received.push({ kind: 'worktree_changes', sessionId });
        this.worktreeChanges.push({ sessionId, notification });
        return true;
      },
      issueRuntimeCredentialProxyGrant: async () => null,
    };
  }

  routeUpdatesFor(sessionId: string): ControlPlaneRouteUpdate[] {
    return this.routeUpdates
      .filter(entry => entry.sessionId === sessionId)
      .map(entry => entry.update);
  }
}

/**
 * A Session peer that mints a real, verifiable runtime-proxy handle for the fence
 * the Sandbox DO passes, without a real Session DO. Sandbox-level tests need
 * `bindRuntimeCredentialProxyHandle` to accept the handle; they do not resolve it.
 */
export function createRuntimeProxyMintingPeer(
  env: Pick<Env, 'NEXTAUTH_SECRET'>,
  identity: (sessionId: string) => { userId: string; kiloSessionId: string }
): (sessionId: string) => ControlPlaneSessionPeer {
  return sessionId => ({
    onRoute: async () => undefined,
    onEvents: async () => undefined,
    onOutcome: async () => undefined,
    // A deliberately long, live delegation so handoff selection can pick this
    // synthetic member without a real authorization store.
    getRuntimeProxyDelegationExpiresAt: async () => Date.now() + 24 * 60 * 60_000,
    onWorktreeChangesReady: async () => true,
    issueRuntimeCredentialProxyGrant: async (fence: ControlRuntimeCredentialProxyFence) => {
      const { userId, kiloSessionId } = identity(sessionId);
      const now = Date.now();
      const grant = createRuntimeProxyGrant({
        plane: 'control',
        allocationId: fence.allocationId,
        providerInstanceId: fence.providerInstanceId,
        connectionId: fence.connectionId,
        wrapperInstanceId: fence.wrapperInstanceId,
        authorizationId: crypto.randomUUID(),
        sessionId,
        kiloSessionId,
        userId,
        mode: 'contained',
        // The real Session DO derives the handle lease from the member's
        // delegation, which is far beyond the 1-hour proactive threshold. A lease
        // equal to the threshold would make a sibling's no-mint decision depend
        // on whether its prepare crosses a wall-clock second boundary (the JWT
        // `exp` is second-granular), which is nondeterministic.
        leaseExpiresAt: now + 24 * 60 * 60_000,
        state: 'active',
        issuedAt: now,
      });
      return issueRuntimeCredentialProxyHandle(env, grant, now);
    },
  });
}
