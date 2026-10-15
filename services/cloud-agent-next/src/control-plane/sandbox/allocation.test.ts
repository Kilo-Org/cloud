import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_TIMERS,
  resolveControlPlaneTimers,
} from '../../shared/control-plane-timers.js';
import {
  initialAllocationState,
  nextAllocationAlarmAt,
  reduceAllocation,
  type AllocationState,
} from './allocation.js';

const TIMERS = CONTROL_PLANE_TIMERS.sandbox;
const MAX_ATTEMPTS = TIMERS.providerStopLadderMs.length + 1;

/** A socket lost after activity, with the two deadlines pinned for a case. */
function disconnectedState(lastActivityAt: number, lastFrameAt: number): AllocationState {
  return {
    ...initialAllocationState(),
    kind: 'disconnected',
    allocationId: 'alloc-1',
    providerRef: 'ref-1',
    lastActivityAt,
    lastFrameAt,
  };
}

/** The last allowed stop attempt; one more retryable result exhausts the ladder. */
function stoppingState(): AllocationState {
  return {
    ...initialAllocationState(),
    kind: 'stopping',
    allocationId: 'alloc-1',
    providerRef: 'ref-1',
    stopAttempt: MAX_ATTEMPTS,
    stopPending: false,
    stopAt: 0,
  };
}

describe('allocation stop-ladder exhaustion', () => {
  it('keeps the provider ref when a retryable result exhausts the ladder', () => {
    const state = stoppingState();
    const { state: next } = reduceAllocation(
      state,
      {
        type: 'stop-result',
        at: 0,
        allocationId: 'alloc-1',
        stopAttempt: MAX_ATTEMPTS,
        confirmed: false,
      },
      TIMERS
    );
    expect(next.kind).toBe('stopped');
    expect(next.providerRef).toBeNull();
    expect(next.unconfirmedProviderRef).toBe('ref-1');
  });

  it('keeps the provider ref when the backstop supersedes the last attempt', () => {
    const state = stoppingState();
    const { state: next } = reduceAllocation(
      state,
      { type: 'tick', at: 1, nextAllocationId: 'alloc-2', retryAllowed: false },
      TIMERS
    );
    expect(next.kind).toBe('stopped');
    expect(next.providerRef).toBeNull();
    expect(next.unconfirmedProviderRef).toBe('ref-1');
  });

  it('does not keep the ref for a confirmed stop', () => {
    const state = stoppingState();
    const { state: next } = reduceAllocation(
      state,
      {
        type: 'stop-result',
        at: 0,
        allocationId: 'alloc-1',
        stopAttempt: MAX_ATTEMPTS,
        confirmed: true,
      },
      TIMERS
    );
    expect(next).toEqual(initialAllocationState());
    expect(next.unconfirmedProviderRef).toBeNull();
  });

  it('clears the preserved ref once the provider reports gone', () => {
    const stopped: AllocationState = {
      ...initialAllocationState(),
      unconfirmedProviderRef: 'ref-1',
    };
    const { state: next } = reduceAllocation(stopped, { type: 'provider-gone', at: 0 }, TIMERS);
    expect(next.kind).toBe('stopped');
    expect(next.unconfirmedProviderRef).toBeNull();
  });
});

describe('allocation idle deadline while disconnected', () => {
  it('stops on the idle deadline when it is the earlier deadline', () => {
    // Activity at 0, so the idle deadline is 10 min. The socket closed at 9 min
    // (1 min before it), so the reconnect wait would not end until 14 min. The
    // idle deadline governs.
    const state = disconnectedState(0, TIMERS.idleMs - 60_000);
    const reduction = reduceAllocation(
      state,
      { type: 'tick', at: TIMERS.idleMs, nextAllocationId: 'alloc-2', retryAllowed: false },
      TIMERS
    );
    expect(reduction.state.kind).toBe('stopping');
    expect(reduction.stopReason).toBe('sandbox_stopped');
    expect(reduction.effects).toEqual([{ type: 'stop', stopAttempt: 1 }]);
  });

  it('waits for the reconnect deadline when it is the earlier deadline', () => {
    // Activity at 0, socket closed at 0, reconnect at 90 s, idle at 10 min.
    const state = disconnectedState(0, 0);
    const early = reduceAllocation(
      state,
      {
        type: 'tick',
        at: TIMERS.reconnectMs - 1,
        nextAllocationId: 'alloc-2',
        retryAllowed: false,
      },
      TIMERS
    );
    expect(early.state.kind).toBe('disconnected');
    const due = reduceAllocation(
      state,
      {
        type: 'tick',
        at: TIMERS.reconnectMs,
        nextAllocationId: 'alloc-2',
        retryAllowed: false,
      },
      TIMERS
    );
    expect(due.state.kind).toBe('stopping');
    expect(due.stopReason).toBe('connection_lost');
  });

  it('arms the alarm at the earlier of the idle and reconnect deadlines', () => {
    // Socket closed at 9 min: idle (10 min) is earlier than reconnect (10.5 min).
    expect(nextAllocationAlarmAt(disconnectedState(0, TIMERS.idleMs - 60_000), TIMERS)).toBe(
      TIMERS.idleMs
    );
    // Socket closed at 0: reconnect (90 s) is earlier than idle (10 min).
    expect(nextAllocationAlarmAt(disconnectedState(0, 0), TIMERS)).toBe(TIMERS.reconnectMs);
  });
});

describe('allocation short idle window around a disconnect', () => {
  const SHORT = resolveControlPlaneTimers({}, 'unattended').sandbox;

  function tick(state: AllocationState, at: number) {
    return reduceAllocation(
      state,
      { type: 'tick', at, nextAllocationId: 'alloc-2', retryAllowed: false },
      SHORT
    );
  }

  function reconnect(state: AllocationState, at: number): AllocationState {
    return reduceAllocation(
      state,
      {
        type: 'hello-accepted',
        at,
        allocationId: 'alloc-1',
        connectionId: 'conn-2',
        wrapperId: 'wr-2',
      },
      SHORT
    ).state;
  }

  it('keeps the idle window shorter than the reconnect window', () => {
    expect(SHORT.idleMs).toBeLessThan(SHORT.reconnectMs);
  });

  it('gives a session active at its last frame the whole reconnect window', () => {
    const state = disconnectedState(0, 0);
    expect(nextAllocationAlarmAt(state, SHORT)).toBe(SHORT.reconnectMs);
    expect(tick(state, SHORT.idleMs).state.kind).toBe('disconnected');
    expect(tick(state, SHORT.reconnectMs - 1).state.kind).toBe('disconnected');
    const due = tick(state, SHORT.reconnectMs);
    expect(due.state.kind).toBe('stopping');
    expect(due.stopReason).toBe('connection_lost');
  });

  it('stops a session idle at its last frame on the idle deadline', () => {
    const state = disconnectedState(0, 30_000);
    expect(nextAllocationAlarmAt(state, SHORT)).toBe(SHORT.idleMs);
    expect(tick(state, SHORT.idleMs - 1).state.kind).toBe('disconnected');
    const due = tick(state, SHORT.idleMs);
    expect(due.state.kind).toBe('stopping');
    expect(due.stopReason).toBe('sandbox_stopped');
  });

  it('lets an active session report activity after a late reconnect', () => {
    const reconnectAt = SHORT.idleMs + 10_000;
    const connected = reconnect(disconnectedState(0, 0), reconnectAt);
    expect(connected.kind).toBe('connected');
    expect(connected.lastActivityAt).toBe(reconnectAt + SHORT.heartbeatMs - SHORT.idleMs);
    expect(nextAllocationAlarmAt(connected, SHORT)).toBe(reconnectAt + SHORT.heartbeatMs);
    expect(tick(connected, reconnectAt).state.kind).toBe('connected');

    const active = reduceAllocation(
      connected,
      {
        type: 'heartbeat',
        at: reconnectAt + 5_000,
        allocationId: 'alloc-1',
        connectionId: 'conn-2',
        active: true,
      },
      SHORT
    ).state;
    expect(active.lastActivityAt).toBe(reconnectAt + 5_000);
  });

  it('does not extend the idle window when an idle session reconnects', () => {
    const connected = reconnect(disconnectedState(0, 30_000), 40_000);
    expect(connected.lastActivityAt).toBe(0);
  });

  it('grants the reconnect grace only once to a wrapper that never heartbeats', () => {
    const reconnectAt = SHORT.idleMs + 10_000;
    const connected = reconnect(disconnectedState(0, 0), reconnectAt);
    const closed = reduceAllocation(
      connected,
      {
        type: 'socket-closed',
        at: reconnectAt + 1_000,
        allocationId: 'alloc-1',
        connectionId: 'conn-2',
        origin: 'peer',
      },
      SHORT
    ).state;
    const idleAt = (connected.lastActivityAt ?? 0) + SHORT.idleMs;
    expect(nextAllocationAlarmAt(closed, SHORT)).toBe(idleAt);
    expect(reconnect(closed, idleAt - 1).lastActivityAt).toBe(connected.lastActivityAt);
    const due = tick(closed, idleAt);
    expect(due.state.kind).toBe('stopping');
    expect(due.stopReason).toBe('sandbox_stopped');
  });
});

describe('allocation create retry', () => {
  const CREATE_FAILED_AT = TIMERS.providerCreateMs;

  function creatingState(): AllocationState {
    return {
      ...initialAllocationState(),
      kind: 'creating',
      allocationId: 'alloc-1',
      createDeadlineAt: CREATE_FAILED_AT,
    };
  }

  function failCreate(retryAllowed: boolean) {
    return reduceAllocation(
      creatingState(),
      {
        type: 'create-failed',
        at: CREATE_FAILED_AT,
        allocationId: 'alloc-1',
        nextAllocationId: 'alloc-2',
        retryAllowed,
      },
      TIMERS
    );
  }

  it('retries a failed create after the short pause, not a full create deadline', () => {
    const { state: waiting, effects } = failCreate(true);
    expect(effects).toEqual([]);
    expect(waiting.kind).toBe('creating');
    expect(waiting.allocationId).toBe('alloc-2');
    expect(waiting.providerRef).toBeNull();
    const retryAt = CREATE_FAILED_AT + TIMERS.providerCreateRetryMs;
    expect(nextAllocationAlarmAt(waiting, TIMERS)).toBe(retryAt);

    const early = reduceAllocation(
      waiting,
      { type: 'tick', at: retryAt - 1, nextAllocationId: 'alloc-3', retryAllowed: true },
      TIMERS
    );
    expect(early.state).toEqual(waiting);
    expect(early.effects).toEqual([]);

    const due = reduceAllocation(
      waiting,
      { type: 'tick', at: retryAt, nextAllocationId: 'alloc-3', retryAllowed: true },
      TIMERS
    );
    expect(due.effects).toEqual([{ type: 'create', allocationId: 'alloc-3' }]);
    expect(due.state.createDeadlineAt).toBe(retryAt + TIMERS.providerCreateMs);
  });

  it('stops instead of retrying when no route attempt time remains', () => {
    const { state, effects } = failCreate(false);
    expect(state).toEqual(initialAllocationState());
    expect(effects).toEqual([]);
  });
});

describe('allocation socket close origin', () => {
  function connectedState(): AllocationState {
    return {
      ...initialAllocationState(),
      kind: 'connected',
      allocationId: 'alloc-1',
      connectionId: 'conn-1',
      providerRef: 'ref-1',
      wrapperId: 'wr-1',
      lastFrameAt: 0,
    };
  }

  it.each(['peer', 'heartbeat_timeout'] as const)(
    'reduces a %s close to the same disconnected state without storing the origin',
    origin => {
      const { state, effects } = reduceAllocation(
        connectedState(),
        {
          type: 'socket-closed',
          at: 123,
          allocationId: 'alloc-1',
          connectionId: 'conn-1',
          origin,
        },
        TIMERS
      );
      expect(state).toEqual({ ...connectedState(), kind: 'disconnected' });
      expect(effects).toEqual([]);
      expect('origin' in state).toBe(false);
      for (const event of [
        {
          type: 'heartbeat',
          at: 124,
          allocationId: 'alloc-1',
          connectionId: 'conn-1',
          active: true,
        },
        {
          type: 'socket-closed',
          at: 124,
          allocationId: 'alloc-1',
          connectionId: 'conn-1',
          origin,
        },
      ] as const) {
        expect(reduceAllocation(state, event, TIMERS)).toEqual({ state, effects: [] });
      }
    }
  );

  it('ignores a close from a superseded connection regardless of origin', () => {
    const state = connectedState();
    const { state: next, effects } = reduceAllocation(
      state,
      {
        type: 'socket-closed',
        at: 123,
        allocationId: 'alloc-1',
        connectionId: 'conn-other',
        origin: 'peer',
      },
      TIMERS
    );
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
