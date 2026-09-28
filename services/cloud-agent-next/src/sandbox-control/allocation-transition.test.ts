import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Decision } from '../sandbox-state/commands.js';
import { operationId } from '../sandbox-state/commands.js';
import { decideAllocation, allocationStateKey } from '../sandbox-state/allocation/reduce.js';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import { connectingHealth } from '../sandbox-state/model/health.js';
import type { AllocationInputEvent } from '../sandbox-state/events.js';
import { POLICY } from '../sandbox-state/schedule.js';
import { logger } from '../logger.js';
import {
  CONTROL_DIAGNOSTIC_STRING_CHARSET,
  CONTROL_DIAGNOSTIC_STRING_MAX_LENGTH,
  logControlDiagnostic,
  type ControlDiagnosticFields,
} from './diagnostics.js';
import {
  ALLOCATION_AGGREGATE,
  ALLOCATION_TRANSITION_EVENT,
  allocationTransitionChanged,
  allocationTransitionFields,
  buildAllocationTransition,
  recordsEqual,
  type AllocationTransition,
} from './allocation-transition.js';

const NOW = 1_000_000;
const INC = 'inc-1';
const EPISODE_ID = '11111111-1111-4111-8111-111111111111';
const STOP_CREATED_AT = NOW - 2_000;
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;

const CAPS: AllocationTarget['capabilities'] = {
  persistentWorkspace: false,
  destroysOnStop: true,
};
const TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: 'ref-1',
  capabilities: CAPS,
};
const UNRESOLVED_TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: null,
  capabilities: CAPS,
};
const INTENT = { intentId: 'intent-1', createdAt: NOW - 5_000 };

function stoppedRecord(): AllocationRecord {
  return { v: 2, resumable: true, state: { kind: 'stopped', summary: null } };
}

function creatingRecord(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'creating',
      requestId: 'req-1',
      target: UNRESOLVED_TARGET,
      createIntent: INTENT,
      attempt: 1,
      deadlineAt: NOW + POLICY.createDeadlineMs,
    },
  };
}

function allocatedHealthyRecord(options?: {
  deadlineAt?: number;
  intentId?: string;
}): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'allocated',
      target: TARGET,
      createIntent: { intentId: options?.intentId ?? INTENT.intentId, createdAt: INTENT.createdAt },
      health: {
        kind: 'healthy',
        incarnation: INC,
        lastHeartbeat: { incarnation: INC, at: NOW - 5_000, ready: true },
        deadlineAt: options?.deadlineAt ?? NOW + POLICY.heartbeatExpiryMs,
      },
      idleAt: null,
    },
  };
}

function allocatedConnectingRecord(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'allocated',
      target: TARGET,
      createIntent: INTENT,
      health: connectingHealth(INC, NOW + POLICY.connectingDeadlineMs),
      idleAt: null,
    },
  };
}

function stoppingDestroyingRecord(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'stopping',
      target: TARGET,
      createIntent: INTENT,
      stopIntent: { reason: 'idle', createdAt: STOP_CREATED_AT, incarnation: INC },
      step: 'destroying',
      attempts: 0,
      deadlineAt: NOW + POLICY.stopDeadlineMs,
    },
  };
}

function mustDecide(
  from: AllocationRecord,
  event: AllocationInputEvent,
  now: number
): Decision<AllocationRecord> {
  const decision = decideAllocation(from, event, now);
  if (decision === undefined) throw new Error(`expected a decision for ${event.type}`);
  return decision;
}

type Scenario = {
  name: string;
  from: AllocationRecord;
  decision: Decision<AllocationRecord>;
  event: AllocationInputEvent;
  expected: Partial<AllocationTransition>;
};

function scenarios(): Scenario[] {
  const demandFrom = stoppedRecord();
  const demandEvent: AllocationInputEvent = {
    type: 'DEMAND',
    requestId: 'req-1',
    target: TARGET,
    createIntent: INTENT,
  };

  const createFrom = creatingRecord();
  const createEvent: AllocationInputEvent = {
    type: 'CREATE_CONFIRMED',
    fence: {
      operationId: operationId('create', INTENT.intentId),
      providerRef: null,
      incarnation: INC,
    },
    providerRef: 'ref-1',
    incarnation: INC,
    at: NOW,
  };

  const failedFrom = allocatedConnectingRecord();
  const launchFailedEvent: AllocationInputEvent = {
    type: 'LAUNCH_FAILED',
    fence: {
      operationId: operationId('launch', INTENT.intentId),
      providerRef: TARGET.providerRef,
      incarnation: INC,
    },
    reason: 'Sandbox launch credential is unavailable',
    at: NOW,
  };

  const unresolvedCreateFrom = creatingRecord();
  const createFailedEvent: AllocationInputEvent = {
    type: 'CREATE_FAILED',
    fence: {
      operationId: operationId('create', INTENT.intentId),
      providerRef: null,
      incarnation: INC,
    },
    reason: 'Sandbox acquisition expired',
    at: NOW,
  };
  const createUnknownEvent: AllocationInputEvent = {
    type: 'CREATE_UNKNOWN',
    fence: {
      operationId: operationId('create', INTENT.intentId),
      providerRef: null,
      incarnation: INC,
    },
    reason: 'container lease update timed out',
    at: NOW,
  };

  const recoveryFrom = allocatedHealthyRecord({ deadlineAt: NOW - 1 });
  const recoveryEvent: AllocationInputEvent = { type: 'DEADLINE', episodeId: EPISODE_ID };

  const idleFrom = allocatedHealthyRecord();
  const idleEvent: AllocationInputEvent = { type: 'IDLE', idleAt: NOW };

  const unhealthyFrom = allocatedHealthyRecord();
  const unhealthyEvent: AllocationInputEvent = {
    type: 'HEALTH_UNHEALTHY',
    verdict: 'unresponsive',
  };

  return [
    {
      name: 'demand stopped -> creating',
      from: demandFrom,
      decision: mustDecide(demandFrom, demandEvent, NOW),
      event: demandEvent,
      expected: {
        aggregate: ALLOCATION_AGGREGATE,
        from: 'stopped',
        to: 'creating',
        event: 'demand',
        deadline: NOW + POLICY.createDeadlineMs,
        at: NOW,
        allocationId: INTENT.intentId,
      },
    },
    {
      name: 'create-confirm creating -> allocated.connecting',
      from: createFrom,
      decision: mustDecide(createFrom, createEvent, NOW),
      event: createEvent,
      expected: {
        from: 'creating',
        to: 'allocated.connecting',
        event: 'create_confirmed',
        deadline: NOW + POLICY.connectingDeadlineMs,
        at: NOW,
        allocationId: INTENT.intentId,
        incarnation: INC,
      },
    },
    {
      name: 'deadline-recovery allocated.healthy -> allocated.recovering',
      from: recoveryFrom,
      decision: mustDecide(recoveryFrom, recoveryEvent, NOW),
      event: recoveryEvent,
      expected: {
        from: 'allocated.healthy',
        to: 'allocated.recovering',
        event: 'deadline',
        deadline: NOW + POLICY.recoveryDeadlineMs,
        at: NOW,
        allocationId: INTENT.intentId,
        incarnation: INC,
      },
    },
    {
      name: 'idle-stop allocated.healthy -> stopping.destroying',
      from: idleFrom,
      decision: mustDecide(idleFrom, idleEvent, NOW),
      event: idleEvent,
      expected: {
        from: 'allocated.healthy',
        to: 'stopping.destroying',
        event: 'idle',
        deadline: NOW + POLICY.stopDeadlineMs,
        at: NOW,
        allocationId: INTENT.intentId,
        incarnation: INC,
        reason: 'idle',
      },
    },
    {
      name: 'health-unresponsive allocated.healthy -> stopping.destroying',
      from: unhealthyFrom,
      decision: mustDecide(unhealthyFrom, unhealthyEvent, NOW),
      event: unhealthyEvent,
      expected: {
        from: 'allocated.healthy',
        to: 'stopping.destroying',
        event: 'health_unhealthy',
        deadline: NOW + POLICY.stopDeadlineMs,
        at: NOW,
        allocationId: INTENT.intentId,
        incarnation: INC,
        reason: 'health_unhealthy_unresponsive',
      },
    },
    {
      name: 'launch-failed allocated.connecting -> unknown',
      from: failedFrom,
      decision: mustDecide(failedFrom, launchFailedEvent, NOW),
      event: launchFailedEvent,
      expected: {
        from: 'allocated.connecting',
        to: 'unknown',
        event: 'launch_failed',
        deadline: NOW + POLICY.observeDeadlineMs,
        at: NOW,
        allocationId: INTENT.intentId,
        incarnation: INC,
        reason: 'Sandbox_launch_credential_is_unavailable',
      },
    },
    {
      name: 'create-failed creating -> stopped',
      from: unresolvedCreateFrom,
      decision: mustDecide(unresolvedCreateFrom, createFailedEvent, NOW),
      event: createFailedEvent,
      expected: {
        from: 'creating',
        to: 'stopped',
        event: 'create_failed',
        deadline: null,
        at: NOW,
        allocationId: INTENT.intentId,
        reason: 'Sandbox_acquisition_expired',
      },
    },
    {
      name: 'create-unknown creating -> unknown',
      from: unresolvedCreateFrom,
      decision: mustDecide(unresolvedCreateFrom, createUnknownEvent, NOW),
      event: createUnknownEvent,
      expected: {
        from: 'creating',
        to: 'unknown',
        event: 'create_unknown',
        deadline: NOW + POLICY.createDeadlineMs,
        at: NOW,
        allocationId: INTENT.intentId,
        reason: 'container_lease_update_timed_out',
      },
    },
  ];
}

function build(scenario: Scenario): AllocationTransition {
  return buildAllocationTransition(
    scenario.from,
    scenario.decision.state,
    scenario.event,
    scenario.decision.deadlineAt,
    NOW
  );
}

describe('allocation transition — builder', () => {
  it.each(scenarios())('$name', scenario => {
    expect(build(scenario)).toMatchObject(scenario.expected);
  });

  it('projects only sanitizer-safe canonical fields for every scenario', () => {
    for (const scenario of scenarios()) {
      const fields = allocationTransitionFields(build(scenario));
      for (const [key, value] of Object.entries(fields)) {
        expect(key, `key ${key}`).toMatch(KEY_PATTERN);
        if (typeof value === 'string') {
          expect(value.length, `length of ${key}`).toBeLessThanOrEqual(
            CONTROL_DIAGNOSTIC_STRING_MAX_LENGTH
          );
          expect(CONTROL_DIAGNOSTIC_STRING_CHARSET.test(value), `charset of ${key}`).toBe(true);
        }
      }
    }
  });
});

describe('allocation transition — no-op contract', () => {
  it('does not emit for an early DEADLINE that leaves the record unchanged', () => {
    const from = creatingRecord();
    const decision = mustDecide(from, { type: 'DEADLINE' }, NOW);
    expect(decision.state).toBe(from);
    expect(decision.commands).toEqual([]);
    expect(allocationTransitionChanged(from, decision.state, decision.commands)).toBe(false);
  });

  it('emits for DEADLINE at or after the deadline', () => {
    const from = creatingRecord();
    const deadline = from.state.kind === 'creating' ? from.state.deadlineAt : NOW;
    const decision = mustDecide(from, { type: 'DEADLINE' }, deadline);
    expect(decision.commands.map(command => command.kind)).toEqual(['Observe']);
    expect(allocationTransitionChanged(from, decision.state, decision.commands)).toBe(true);
  });

  it('emits for a heartbeat renewal whose state labels are unchanged', () => {
    const from = allocatedHealthyRecord();
    const event: AllocationInputEvent = {
      type: 'HEARTBEAT',
      incarnation: INC,
      at: NOW,
      ready: true,
    };
    const decision = mustDecide(from, event, NOW);
    expect(allocationStateKey(from.state)).toBe('allocated.healthy');
    expect(allocationStateKey(decision.state.state)).toBe('allocated.healthy');
    expect(decision.commands).toEqual([]);
    expect(allocationTransitionChanged(from, decision.state, decision.commands)).toBe(true);
  });

  it('emits for the OBSERVED non-absent retry of the unchanged record', () => {
    const from = stoppingDestroyingRecord();
    const event: AllocationInputEvent = {
      type: 'OBSERVED',
      fence: {
        operationId: operationId('observe', STOP_CREATED_AT),
        providerRef: TARGET.providerRef,
        incarnation: INC,
      },
      result: 'present',
    };
    const decision = mustDecide(from, event, NOW);
    expect(decision.state).toBe(from);
    expect(decision.commands.length).toBeGreaterThan(0);
    expect(allocationTransitionChanged(from, decision.state, decision.commands)).toBe(true);
  });

  it('emits for the CANCEL retry of the unchanged record', () => {
    const from = stoppingDestroyingRecord();
    const decision = mustDecide(from, { type: 'CANCEL', scope: 'allocation' }, NOW);
    expect(decision.state).toBe(from);
    expect(decision.commands.length).toBeGreaterThan(0);
    expect(allocationTransitionChanged(from, decision.state, decision.commands)).toBe(true);
  });
});

describe('allocation transition — recordsEqual', () => {
  it('compares structurally and ignores key order', () => {
    const base = allocatedHealthyRecord();
    if (base.state.kind !== 'allocated') throw new Error('expected allocated');
    const reordered: AllocationRecord = {
      resumable: base.resumable,
      state: {
        idleAt: base.state.idleAt,
        health: { ...base.state.health },
        createIntent: { ...base.state.createIntent },
        target: { ...TARGET },
        kind: 'allocated',
      },
      v: base.v,
    };
    expect(recordsEqual(base, reordered)).toBe(true);
    expect(recordsEqual(base, { ...base, resumable: false })).toBe(false);
  });
});

describe('allocation transition — diagnostic boundary', () => {
  const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

  afterEach(() => {
    withFields.mockClear();
    info.mockClear();
  });

  it('redacts an unsafe intent id and stop reason but keeps the canonical fields', () => {
    const from = allocatedHealthyRecord({ intentId: 'intent id / unsafe' });
    const event: AllocationInputEvent = {
      type: 'CANCEL',
      scope: 'allocation',
      reason: 'stop reason with spaces!',
    };
    const decision = mustDecide(from, event, NOW);
    const transition = buildAllocationTransition(
      from,
      decision.state,
      event,
      decision.deadlineAt,
      NOW
    );

    logControlDiagnostic(ALLOCATION_TRANSITION_EVENT, allocationTransitionFields(transition));

    expect(withFields).toHaveBeenCalledTimes(1);
    const fields = withFields.mock.calls[0]?.[0] as ControlDiagnosticFields;
    expect(fields.allocationId).toBe('redacted');
    expect(fields.reason).toBe('redacted');
    expect(fields.from).toBe('allocated.healthy');
    expect(fields.to).toBe('stopping.destroying');
    expect(fields.event).toBe('cancel');
  });
});
