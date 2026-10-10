import type { ControlPlaneTimers } from '../../shared/control-plane-timers.js';
import type { ControlPlaneFailureReason } from '../../shared/control-plane-protocol.js';
import type { AgentSandboxProvider } from '../../types.js';

export type SandboxTimers = ControlPlaneTimers['sandbox'];

export const ALLOCATION_KINDS = [
  'stopped',
  'creating',
  'starting',
  'connected',
  'disconnected',
  'stopping',
] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];

/**
 * One value per allocation (spec §6). The `kind` is the state; the other fields
 * are data the table and the timers need, not side flags that re-encode it.
 *
 * `connectionId` is the identity of the socket that most recently completed
 * `hello` for this allocation, retained across disconnect as the physical
 * binding. Frames and closes apply only while connected and when the socket's
 * attachment carries the same id, so a replaced or rejected socket cannot move
 * a healthy allocation.
 *
 * The provider kind is not here: the persisted provider pin owns it (M1).
 */
export type AllocationState = {
  kind: AllocationKind;
  allocationId: string | null;
  connectionId: string | null;
  providerRef: string | null;
  wrapperId: string | null;
  lastFrameAt: number | null;
  lastActivityAt: number | null;
  createDeadlineAt: number | null;
  firstConnectDeadlineAt: number | null;
  /** Id of the current stop attempt; results for other ids are ignored (N1). */
  stopAttempt: number;
  /** True when the next attempt is scheduled but its stop call is not issued yet. */
  stopPending: boolean;
  stopAt: number | null;
  /**
   * Evidence kept only on `stopped` when the stop ladder was exhausted without a
   * provider confirmation (spec §9): the container may still run. `providerRef`
   * stays null so a `stopped` state with a live-looking ref is never re-encoded
   * here; deletion reads this field instead of trusting `stopped`.
   */
  unconfirmedProviderRef: string | null;
};

/** Allocation state plus the provider kind owned by the persisted pin. */
export type AllocationView = AllocationState & { provider: AgentSandboxProvider };

export function initialAllocationState(): AllocationState {
  return {
    kind: 'stopped',
    allocationId: null,
    connectionId: null,
    providerRef: null,
    wrapperId: null,
    lastFrameAt: null,
    lastActivityAt: null,
    createDeadlineAt: null,
    firstConnectDeadlineAt: null,
    stopAttempt: 0,
    stopPending: false,
    stopAt: null,
    unconfirmedProviderRef: null,
  };
}

export type AllocationEvent =
  /** A session needs an allocation (from `prepare`, B3). */
  | { type: 'ensure'; at: number; allocationId: string }
  /**
   * The provider ref is known. Committed before `launch` (N4), so an accepted
   * `hello` never observes a null ref.
   */
  | { type: 'provider-ref'; at: number; allocationId: string; providerRef: string }
  | { type: 'created'; at: number; allocationId: string; providerRef: string }
  | {
      type: 'create-failed';
      at: number;
      allocationId: string;
      nextAllocationId: string;
      /** Whether the routes table still has a pending attempt deadline (M2). */
      retryAllowed: boolean;
    }
  | {
      type: 'hello-accepted';
      at: number;
      allocationId: string;
      connectionId: string;
      wrapperId: string;
    }
  | { type: 'heartbeat'; at: number; allocationId: string; connectionId: string; active: boolean }
  /**
   * `origin` distinguishes the two producers of an identical close: the wrapper
   * or its transport closed the socket (`peer`), or the owner closed it after the
   * heartbeat deadline (`heartbeat_timeout`). Diagnostic-only; the reducer does
   * not read it.
   */
  | {
      type: 'socket-closed';
      at: number;
      allocationId: string;
      connectionId: string;
      origin: 'peer' | 'heartbeat_timeout';
    }
  | { type: 'provider-gone'; at: number }
  /** `reason` is why the caller stops the sandbox; every stop must name one. */
  | { type: 'stop-requested'; at: number; reason: ControlPlaneFailureReason }
  | {
      type: 'stop-result';
      at: number;
      allocationId: string | null;
      stopAttempt: number;
      confirmed: boolean;
    }
  | {
      type: 'tick';
      at: number;
      nextAllocationId: string;
      /** Whether the routes table still has a pending attempt deadline (M2). */
      retryAllowed: boolean;
    };

export type AllocationEffect =
  | { type: 'create'; allocationId: string }
  | { type: 'stop'; stopAttempt: number }
  | { type: 'close-socket' }
  | { type: 'lease' };

export type AllocationReduction = {
  state: AllocationState;
  effects: AllocationEffect[];
  /**
   * Set only when this event enters `stopping`: why the sandbox is stopping, so
   * the caller notifies ready routes without re-deriving the cause.
   */
  stopReason?: ControlPlaneFailureReason;
};

const NO_EFFECTS: AllocationEffect[] = [];

function maxStopAttempts(timers: SandboxTimers): number {
  return timers.providerStopLadderMs.length + 1;
}

function enterStopping(
  state: AllocationState,
  at: number,
  timers: SandboxTimers,
  reason: ControlPlaneFailureReason | undefined
): AllocationReduction {
  if (reason === undefined) {
    throw new Error('Entering stopping without a stop reason');
  }
  return {
    // H2/N1: a future backstop keeps the alarm non-null and gives the in-flight
    // attempt one id; a stale result for another id is ignored.
    state: {
      ...state,
      kind: 'stopping',
      stopAttempt: 1,
      stopPending: false,
      stopAt: at + timers.providerStopAttemptMs,
    },
    effects: [{ type: 'stop', stopAttempt: 1 }],
    stopReason: reason,
  };
}

/**
 * The stop ladder ran out of attempts without a provider confirmation (spec §9).
 * The state is `stopped` for routing, but the provider ref is kept as the only
 * evidence the physical sandbox may still run. Deletion must not read `stopped`
 * as a confirmed stop while this ref is present.
 */
function stoppedAfterUnconfirmedStop(state: AllocationState): AllocationState {
  return { ...initialAllocationState(), unconfirmedProviderRef: state.providerRef };
}

/** Supersede a hung attempt with a new id, so its late result cannot apply. */
function supersedeStopAttempt(
  state: AllocationState,
  at: number,
  timers: SandboxTimers
): AllocationReduction {
  const attempt = state.stopAttempt + 1;
  if (attempt > maxStopAttempts(timers)) {
    return { state: stoppedAfterUnconfirmedStop(state), effects: NO_EFFECTS };
  }
  return {
    state: {
      ...state,
      stopAttempt: attempt,
      stopPending: false,
      stopAt: at + timers.providerStopAttemptMs,
    },
    effects: [{ type: 'stop', stopAttempt: attempt }],
  };
}

/** Schedule the next attempt after a retryable result, honouring the ladder. */
function scheduleStopAttempt(
  state: AllocationState,
  at: number,
  timers: SandboxTimers
): AllocationReduction {
  const attempt = state.stopAttempt + 1;
  if (attempt > maxStopAttempts(timers)) {
    return { state: stoppedAfterUnconfirmedStop(state), effects: NO_EFFECTS };
  }
  const delay = timers.providerStopLadderMs[state.stopAttempt - 1] ?? 0;
  return {
    state: { ...state, stopAttempt: attempt, stopPending: true, stopAt: at + delay },
    effects: NO_EFFECTS,
  };
}

export function connectionMatches(
  state: AllocationState,
  allocationId: string,
  connectionId: string
): boolean {
  return (
    state.kind === 'connected' &&
    state.allocationId !== null &&
    state.allocationId === allocationId &&
    state.connectionId !== null &&
    state.connectionId === connectionId
  );
}

export function reduceAllocation(
  state: AllocationState,
  event: AllocationEvent,
  timers: SandboxTimers
): AllocationReduction {
  switch (event.type) {
    case 'ensure': {
      if (state.kind !== 'stopped') return { state, effects: NO_EFFECTS };
      return {
        state: {
          ...initialAllocationState(),
          kind: 'creating',
          allocationId: event.allocationId,
          createDeadlineAt: event.at + timers.providerCreateMs,
        },
        effects: [{ type: 'create', allocationId: event.allocationId }],
      };
    }

    case 'provider-ref': {
      if (state.kind === 'stopped' || state.kind === 'stopping') {
        return { state, effects: NO_EFFECTS };
      }
      if (state.allocationId !== event.allocationId) return { state, effects: NO_EFFECTS };
      return { state: { ...state, providerRef: event.providerRef }, effects: NO_EFFECTS };
    }

    case 'created': {
      if (state.kind !== 'creating' || state.allocationId !== event.allocationId) {
        return { state, effects: NO_EFFECTS };
      }
      return {
        state: {
          ...state,
          kind: 'starting',
          providerRef: event.providerRef,
          firstConnectDeadlineAt: event.at + timers.wrapperFirstConnectMs,
        },
        effects: NO_EFFECTS,
      };
    }

    case 'create-failed': {
      if (state.kind !== 'creating' || state.allocationId !== event.allocationId) {
        return { state, effects: NO_EFFECTS };
      }
      if (event.retryAllowed) {
        // Nothing is in flight now, so the deadline is the retry pause; the tick
        // that reaches it starts the next attempt with a full create deadline.
        return {
          state: {
            ...state,
            allocationId: event.nextAllocationId,
            providerRef: null,
            createDeadlineAt: event.at + timers.providerCreateRetryMs,
          },
          effects: NO_EFFECTS,
        };
      }
      return { state: initialAllocationState(), effects: NO_EFFECTS };
    }

    case 'hello-accepted': {
      if (state.kind === 'stopped' || state.kind === 'stopping') {
        return { state, effects: NO_EFFECTS };
      }
      if (state.allocationId !== event.allocationId) return { state, effects: NO_EFFECTS };
      const next: AllocationState = {
        ...state,
        kind: 'connected',
        connectionId: event.connectionId,
        wrapperId: event.wrapperId,
        lastFrameAt: event.at,
      };
      // M3: the first connect (creating or starting) starts the idle clock; a
      // reconnect refreshes liveness but must not extend the idle window.
      if (state.kind === 'creating' || state.kind === 'starting') next.lastActivityAt = event.at;
      return { state: next, effects: NO_EFFECTS };
    }

    case 'heartbeat': {
      if (!connectionMatches(state, event.allocationId, event.connectionId)) {
        return { state, effects: NO_EFFECTS };
      }
      const next: AllocationState = { ...state, lastFrameAt: event.at };
      if (!event.active) return { state: next, effects: NO_EFFECTS };
      return {
        state: { ...next, lastActivityAt: event.at },
        effects: [{ type: 'lease' }],
      };
    }

    case 'socket-closed': {
      if (!connectionMatches(state, event.allocationId, event.connectionId)) {
        return { state, effects: NO_EFFECTS };
      }
      return { state: { ...state, kind: 'disconnected' }, effects: NO_EFFECTS };
    }

    case 'provider-gone': {
      // The provider reports the sandbox gone: proof of a physical stop, so a
      // preserved unconfirmed ref is cleared even when routing was already
      // `stopped` from an exhausted ladder.
      if (state.kind === 'stopped') {
        return { state: { ...state, unconfirmedProviderRef: null }, effects: NO_EFFECTS };
      }
      return { state: initialAllocationState(), effects: NO_EFFECTS };
    }

    case 'stop-requested': {
      if (state.kind === 'stopped' || state.kind === 'stopping') {
        return { state, effects: NO_EFFECTS };
      }
      return enterStopping(state, event.at, timers, event.reason);
    }

    case 'stop-result': {
      if (state.kind !== 'stopping' || state.allocationId !== event.allocationId) {
        return { state, effects: NO_EFFECTS };
      }
      // Ignore a result for an attempt that has been superseded (N1).
      if (event.stopAttempt !== state.stopAttempt || state.stopPending) {
        return { state, effects: NO_EFFECTS };
      }
      if (event.confirmed) return { state: initialAllocationState(), effects: NO_EFFECTS };
      return scheduleStopAttempt(state, event.at, timers);
    }

    case 'tick':
      return reduceTick(state, event, timers);

    default:
      return { state, effects: NO_EFFECTS };
  }
}

function reduceTick(
  state: AllocationState,
  event: Extract<AllocationEvent, { type: 'tick' }>,
  timers: SandboxTimers
): AllocationReduction {
  switch (state.kind) {
    case 'creating': {
      if (state.createDeadlineAt === null || event.at < state.createDeadlineAt) {
        return { state, effects: NO_EFFECTS };
      }
      if (event.retryAllowed) {
        return {
          state: {
            ...state,
            allocationId: event.nextAllocationId,
            providerRef: null,
            createDeadlineAt: event.at + timers.providerCreateMs,
          },
          effects: [{ type: 'create', allocationId: event.nextAllocationId }],
        };
      }
      return { state: initialAllocationState(), effects: NO_EFFECTS };
    }

    case 'starting': {
      if (state.firstConnectDeadlineAt === null || event.at < state.firstConnectDeadlineAt) {
        return { state, effects: NO_EFFECTS };
      }
      return enterStopping(state, event.at, timers, 'connection_lost');
    }

    case 'connected': {
      if (state.lastFrameAt !== null && event.at >= state.lastFrameAt + timers.heartbeatMs) {
        return { state, effects: [{ type: 'close-socket' }] };
      }
      if (state.lastActivityAt !== null && event.at >= state.lastActivityAt + timers.idleMs) {
        return enterStopping(state, event.at, timers, 'sandbox_stopped');
      }
      return { state, effects: NO_EFFECTS };
    }

    case 'disconnected': {
      // The idle deadline still governs after a socket close: a disconnect must
      // not extend the idle window (M3), or a sandbox that stops itself at the
      // idle boundary would hold its allocation for the whole reconnect wait.
      if (
        state.lastActivityAt !== null &&
        event.at >= state.lastActivityAt + timers.idleMs &&
        (state.lastFrameAt === null ||
          state.lastActivityAt + timers.idleMs <= state.lastFrameAt + timers.reconnectMs)
      ) {
        return enterStopping(state, event.at, timers, 'sandbox_stopped');
      }
      if (state.lastFrameAt === null || event.at < state.lastFrameAt + timers.reconnectMs) {
        return { state, effects: NO_EFFECTS };
      }
      return enterStopping(state, event.at, timers, 'connection_lost');
    }

    case 'stopping': {
      if (state.stopAt === null || event.at < state.stopAt) {
        return { state, effects: NO_EFFECTS };
      }
      if (state.stopPending) {
        // The scheduled attempt is due: issue exactly one stop for it.
        return {
          state: { ...state, stopPending: false, stopAt: event.at + timers.providerStopAttemptMs },
          effects: [{ type: 'stop', stopAttempt: state.stopAttempt }],
        };
      }
      // The in-flight attempt has not produced a result: supersede it (N1).
      return supersedeStopAttempt(state, event.at, timers);
    }

    default:
      return { state, effects: NO_EFFECTS };
  }
}

/**
 * The earliest deadline the allocation owns, or null when it owns none. The DO
 * keeps exactly one alarm set to this instant. `stopping` always owns one (H2).
 */
export function nextAllocationAlarmAt(
  state: AllocationState,
  timers: SandboxTimers
): number | null {
  switch (state.kind) {
    case 'creating':
      return state.createDeadlineAt;
    case 'starting':
      return state.firstConnectDeadlineAt;
    case 'connected': {
      const candidates: number[] = [];
      if (state.lastFrameAt !== null) candidates.push(state.lastFrameAt + timers.heartbeatMs);
      if (state.lastActivityAt !== null) candidates.push(state.lastActivityAt + timers.idleMs);
      return candidates.length === 0 ? null : Math.min(...candidates);
    }
    case 'disconnected': {
      const candidates: number[] = [];
      if (state.lastActivityAt !== null) candidates.push(state.lastActivityAt + timers.idleMs);
      if (state.lastFrameAt !== null) candidates.push(state.lastFrameAt + timers.reconnectMs);
      return candidates.length === 0 ? null : Math.min(...candidates);
    }
    case 'stopping':
      return state.stopAt;
    default:
      return null;
  }
}
