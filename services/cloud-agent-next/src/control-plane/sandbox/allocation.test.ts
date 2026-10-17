import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_TIMERS } from '../../shared/control-plane-timers.js';
import {
  allocationStartupDeadlineAt,
  initialAllocationState,
  nextAllocationAlarmAt,
  reduceAllocation,
  type AllocationState,
} from './allocation.js';

const TIMERS = CONTROL_PLANE_TIMERS.sandbox;
const MAX_ATTEMPTS = TIMERS.providerStopLadderMs.length + 1;

describe('native startup attempt deadline', () => {
  const creating: AllocationState = {
    ...initialAllocationState(),
    kind: 'creating',
    allocationId: 'alloc-1',
    createDeadlineAt: 1_000,
  };

  it('persists a tighter attempt bound without replacing the outer deadline', () => {
    const reserved = reduceAllocation(
      creating,
      {
        type: 'provider-ref',
        at: 100,
        allocationId: 'alloc-1',
        providerRef: 'ref-1',
        firstConnectDeadlineAt: 500,
      },
      TIMERS
    ).state;
    const reentered = reduceAllocation(
      reserved,
      {
        type: 'provider-ref',
        at: 200,
        allocationId: 'alloc-1',
        providerRef: 'ref-1',
        firstConnectDeadlineAt: 900,
      },
      TIMERS
    ).state;
    expect(reentered.createDeadlineAt).toBe(1_000);
    expect(allocationStartupDeadlineAt(reentered)).toBe(500);
    expect(nextAllocationAlarmAt(reentered, TIMERS)).toBe(500);
    const started = reduceAllocation(
      reentered,
      {
        type: 'created',
        at: 300,
        allocationId: 'alloc-1',
        providerRef: 'ref-1',
        firstConnectDeadlineAt: 900,
      },
      TIMERS
    ).state;
    expect(started.firstConnectDeadlineAt).toBe(500);
  });

  it('stops at the attempt bound while the outer deadline remains open', () => {
    const result = reduceAllocation(
      { ...creating, providerRef: 'ref-1', firstConnectDeadlineAt: 500 },
      {
        type: 'tick',
        at: 500,
        nextAllocationId: 'alloc-2',
        retryAllowed: true,
        bootstrapExpiryReason: 'runtime_artifact_deadline',
      },
      TIMERS
    );
    expect(result.state.kind).toBe('stopping');
    expect(result.state.allocationId).toBe('alloc-1');
    expect(result.state.createDeadlineAt).toBe(1_000);
    expect(result.stopReason).toBe('runtime_artifact_deadline');
    expect(result.effects).toEqual([{ type: 'stop', stopAttempt: 1 }]);
  });

  it('clears the old phase bound only when it creates a different allocation', () => {
    const retry = reduceAllocation(
      { ...creating, providerRef: 'ref-1', firstConnectDeadlineAt: 500 },
      {
        type: 'create-failed',
        at: 400,
        allocationId: 'alloc-1',
        nextAllocationId: 'alloc-2',
        retryAllowed: true,
      },
      TIMERS
    ).state;
    expect(retry.allocationId).toBe('alloc-2');
    expect(retry.firstConnectDeadlineAt).toBeNull();
  });
});

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

describe('allocation recovery after delivery', () => {
  it('keeps the reconnect window when delivery advances activity past the last frame', () => {
    const state = disconnectedState(1_000, 0);
    expect(nextAllocationAlarmAt(state, TIMERS)).toBe(TIMERS.reconnectMs);
    const early = reduceAllocation(
      state,
      { type: 'tick', at: 61_000, nextAllocationId: 'alloc-2', retryAllowed: false },
      TIMERS
    );
    expect(early.state.kind).toBe('disconnected');
    const due = reduceAllocation(
      state,
      { type: 'tick', at: TIMERS.reconnectMs, nextAllocationId: 'alloc-2', retryAllowed: false },
      TIMERS
    );
    expect(due.stopReason).toBe('connection_lost');
  });

  it('preserves the activity clock and heartbeat deadline after a late reconnect', () => {
    const reconnectAt = 70_000;
    const connected = reduceAllocation(
      disconnectedState(1_000, 0),
      {
        type: 'hello-accepted',
        at: reconnectAt,
        allocationId: 'alloc-1',
        connectionId: 'conn-2',
        wrapperId: 'wr-2',
      },
      TIMERS
    ).state;
    expect(connected.kind).toBe('connected');
    expect(connected.lastActivityAt).toBe(1_000);
    expect(nextAllocationAlarmAt(connected, TIMERS)).toBe(reconnectAt + TIMERS.heartbeatMs);
    const reduction = reduceAllocation(
      connected,
      { type: 'tick', at: reconnectAt, nextAllocationId: 'alloc-2', retryAllowed: false },
      TIMERS
    );
    expect(reduction.state.kind).toBe('connected');
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

  it('fails an expired cold bootstrap launch (ref present) instead of renewing', () => {
    const { state, effects, stopReason } = reduceAllocation(
      { ...creatingState(), providerRef: 'ref-1' },
      {
        type: 'tick',
        at: CREATE_FAILED_AT,
        nextAllocationId: 'alloc-2',
        retryAllowed: true,
        bootstrapExpiryReason: 'runtime_artifact_deadline',
      },
      TIMERS
    );
    expect(state.kind).toBe('stopping');
    // The original id and deadline survive; the retry branch never ran.
    expect(state.allocationId).toBe('alloc-1');
    expect(state.createDeadlineAt).toBe(CREATE_FAILED_AT);
    expect(stopReason).toBe('runtime_artifact_deadline');
    expect(effects).toEqual([{ type: 'stop', stopAttempt: 1 }]);
  });

  it('keeps the generic cold retry when the tick lands on a null-ref retry pause', () => {
    // `create-failed` with retryAllowed leaves a null ref and a short pause. The
    // cold reason must not terminalize that pause; it starts the next attempt
    // with a full create budget, exactly as the generic policy does.
    const { state, effects } = reduceAllocation(
      { ...creatingState(), providerRef: null },
      {
        type: 'tick',
        at: CREATE_FAILED_AT,
        nextAllocationId: 'alloc-2',
        retryAllowed: true,
        bootstrapExpiryReason: 'runtime_artifact_deadline',
      },
      TIMERS
    );
    expect(state.kind).toBe('creating');
    expect(state.allocationId).toBe('alloc-2');
    expect(state.providerRef).toBeNull();
    expect(state.createDeadlineAt).toBe(CREATE_FAILED_AT + TIMERS.providerCreateMs);
    expect(effects).toEqual([{ type: 'create', allocationId: 'alloc-2' }]);
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

describe('allocation first-connect deadline', () => {
  function creatingState(): AllocationState {
    return reduceAllocation(
      initialAllocationState(),
      { type: 'ensure', at: 0, allocationId: 'alloc-1' },
      TIMERS
    ).state;
  }

  it('uses the per-phase first-connect window when the created event names no deadline', () => {
    const { state } = reduceAllocation(
      creatingState(),
      { type: 'created', at: 1_000, allocationId: 'alloc-1', providerRef: 'ref-1' },
      TIMERS
    );
    expect(state.kind).toBe('starting');
    expect(state.firstConnectDeadlineAt).toBe(1_000 + TIMERS.wrapperFirstConnectMs);
  });

  it('keeps the absolute cold-bootstrap deadline instead of a fresh window', () => {
    const absolute = 2_500;
    const { state } = reduceAllocation(
      creatingState(),
      {
        type: 'created',
        at: 1_000,
        allocationId: 'alloc-1',
        providerRef: 'ref-1',
        firstConnectDeadlineAt: absolute,
      },
      TIMERS
    );
    expect(state.firstConnectDeadlineAt).toBe(absolute);
  });

  function startingState(): AllocationState {
    return reduceAllocation(
      creatingState(),
      {
        type: 'created',
        at: 1_000,
        allocationId: 'alloc-1',
        providerRef: 'ref-1',
        firstConnectDeadlineAt: 2_500,
      },
      TIMERS
    ).state;
  }

  it('owns the cold bootstrap expiry reason carried by the tick', () => {
    const { state, stopReason } = reduceAllocation(
      startingState(),
      {
        type: 'tick',
        at: 2_500,
        nextAllocationId: 'alloc-2',
        retryAllowed: true,
        bootstrapExpiryReason: 'runtime_artifact_deadline',
      },
      TIMERS
    );
    expect(state.kind).toBe('stopping');
    expect(stopReason).toBe('runtime_artifact_deadline');
  });

  it('keeps connection_lost for a tick that carries no cold reason', () => {
    const { state, stopReason } = reduceAllocation(
      startingState(),
      { type: 'tick', at: 2_500, nextAllocationId: 'alloc-2', retryAllowed: true },
      TIMERS
    );
    expect(state.kind).toBe('stopping');
    expect(stopReason).toBe('connection_lost');
  });
});
