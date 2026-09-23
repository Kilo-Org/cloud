import { describe, expect, it } from 'vitest';
import { ALLOCATION_TRANSITIONS, allocationStateKey, decideAllocation } from './reduce.js';
import { operationId } from '../commands.js';
import type { AllocationInputEvent, ResultFence } from '../events.js';
import type {
  AllocationRecord,
  AllocationTarget,
  ProviderCapabilities,
  StoppingDestroying,
  StopProof,
} from '../model/allocation.js';
import { POLICY } from '../schedule.js';

const NOW = 1_000_000;
const INC = 'inc-1';
const EPISODE_ID = '11111111-1111-4111-8111-111111111111';

const CF_CAPS: ProviderCapabilities = { persistentWorkspace: false, destroysOnStop: true };
const VERCEL_CAPS: ProviderCapabilities = { persistentWorkspace: true, destroysOnStop: false };

const UNRESOLVED_TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: null,
  capabilities: CF_CAPS,
};

const TARGET: AllocationTarget = { ...UNRESOLVED_TARGET, providerRef: 'provider-ref-1' };

const VERCEL_TARGET: AllocationTarget = {
  provider: 'vercel',
  providerRef: 'vercel-ref-1',
  allocationName: 'vercel-small',
  capabilities: VERCEL_CAPS,
};

const CREATE_INTENT = { intentId: 'intent-1', createdAt: NOW - 5_000 };
const CREATE_OP = operationId('create', CREATE_INTENT.intentId);

function fence(
  operationIdValue: string,
  providerRef: string | null = null,
  incarnation: string | null = null
): ResultFence {
  return { operationId: operationIdValue, providerRef, incarnation };
}

function stopped(resumable = true): AllocationRecord {
  return { v: 2, resumable, state: { kind: 'stopped', summary: null } };
}

function creating(target: AllocationTarget = UNRESOLVED_TARGET): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'creating',
      requestId: 'req-1',
      target,
      createIntent: CREATE_INTENT,
      attempt: 1,
      deadlineAt: NOW + POLICY.createDeadlineMs,
    },
  };
}

function allocated(healthInput: HealthStateInput, idleAt: number | null = null): AllocationRecord {
  const health =
    healthInput.kind === 'connecting'
      ? {
          kind: 'connecting' as const,
          incarnation: INC,
          deadlineAt: NOW + POLICY.connectingDeadlineMs,
        }
      : healthInput.kind === 'healthy'
        ? {
            kind: 'healthy' as const,
            incarnation: INC,
            lastHeartbeat: { incarnation: INC, at: NOW - 1_000, ready: true },
            deadlineAt: NOW + POLICY.heartbeatExpiryMs,
          }
        : healthInput.kind === 'recovering'
          ? {
              kind: 'recovering' as const,
              incarnation: INC,
              step: 'check_sandbox' as const,
              attempts: 1,
              deadlineAt: NOW + POLICY.recoveryDeadlineMs,
              episodeId: EPISODE_ID,
              cause: 'activation_pending' as const,
            }
          : { kind: 'unhealthy' as const, incarnation: INC, verdict: healthInput.verdict };
  return {
    v: 2,
    resumable: true,
    state: { kind: 'allocated', target: TARGET, createIntent: CREATE_INTENT, health, idleAt },
  };
}

type HealthStateInput =
  | { kind: 'connecting' }
  | { kind: 'healthy' }
  | { kind: 'recovering' }
  | { kind: 'unhealthy'; verdict: 'absent' | 'unresponsive' };

function stoppingDestroying(attempts = 0): StoppingDestroying {
  return {
    kind: 'stopping',
    target: TARGET,
    createIntent: CREATE_INTENT,
    stopIntent: { reason: 'test', createdAt: NOW - 1_000, incarnation: INC },
    step: 'destroying',
    attempts,
    deadlineAt: NOW + POLICY.stopDeadlineMs,
  };
}

function stoppingRecord(attempts = 0): AllocationRecord {
  return { v: 2, resumable: true, state: stoppingDestroying(attempts) };
}

function checkRequired(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'stopping',
      target: TARGET,
      createIntent: CREATE_INTENT,
      stopIntent: { reason: 'test', createdAt: NOW - 1_000, incarnation: INC },
      step: 'check_required',
      attempts: 0,
    },
  };
}

function unknown(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'unknown',
      target: TARGET,
      createIntent: CREATE_INTENT,
      stopIntent: null,
      attempts: 0,
      reason: 'test',
      deadlineAt: NOW + POLICY.observeDeadlineMs,
    },
  };
}

function commandKinds(decision: ReturnType<typeof decideAllocation>): string[] {
  return decision?.commands.map(command => command.kind) ?? [];
}

function notifyCommandOf(decision: ReturnType<typeof decideAllocation>) {
  const command = decision?.commands.find(candidate => candidate.kind === 'NotifySession');
  return command?.kind === 'NotifySession' ? command : undefined;
}

function destroyProof(overrides: Partial<StopProof> = {}): StopProof {
  return {
    effect: 'destroy',
    at: NOW,
    providerRef: 'provider-ref-1',
    incarnation: INC,
    reason: 'test',
    ...overrides,
  };
}

describe('allocation reducer — design §5 transitions', () => {
  it('stopped + DEMAND → creating and emits Create', () => {
    const decision = decideAllocation(
      stopped(),
      {
        type: 'DEMAND',
        requestId: 'req-9',
        target: TARGET,
        createIntent: CREATE_INTENT,
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('creating');
    expect(commandKinds(decision)).toEqual(['Create']);
    expect(decision?.deadlineAt).toBe(NOW + POLICY.createDeadlineMs);
    expect(decision?.state.resumable).toBe(true);
  });

  it('stopped + ACQUIRE → creating', () => {
    const decision = decideAllocation(
      stopped(false),
      {
        type: 'ACQUIRE',
        requestId: 'req-9',
        target: TARGET,
        createIntent: CREATE_INTENT,
        deliveryDeadlineAt: NOW + 10_000,
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('creating');
    expect(decision?.state.resumable).toBe(false);
  });

  it('creating + CREATE_CONFIRMED installs the confirmed reference and containment', () => {
    const decision = decideAllocation(
      creating(),
      {
        type: 'CREATE_CONFIRMED',
        fence: fence(CREATE_OP, 'provider-ref-1', 'inc-created'),
        providerRef: 'provider-ref-1',
        incarnation: 'inc-created',
        at: NOW,
        resolvedContainment: { kilocode: true, github: true, providerRef: 'provider-ref-1' },
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('allocated');
    const state = decision!.state.state;
    expect(state.kind === 'allocated' && state.target.providerRef).toBe('provider-ref-1');
    expect(state.kind === 'allocated' && state.target.resolvedContainment?.providerRef).toBe(
      'provider-ref-1'
    );
    expect(state.kind === 'allocated' && state.health.kind).toBe('connecting');
    expect(decision?.deadlineAt).toBe(NOW + POLICY.connectingDeadlineMs);
  });

  it('uses the create effect incarnation (not the intent id) for the stop proof', () => {
    // The create effect may confirm an incarnation that differs from the create
    // intent id. The aggregate must carry the returned incarnation, and the
    // immediate stop notification must be fenced to it — never to the intent id.
    const confirmed = decideAllocation(
      creating(),
      {
        type: 'CREATE_CONFIRMED',
        fence: fence(CREATE_OP, 'provider-ref-1', 'inc-created'),
        providerRef: 'provider-ref-1',
        incarnation: 'inc-created',
        at: NOW,
        resolvedContainment: { kilocode: true, github: true, providerRef: 'provider-ref-1' },
      },
      NOW
    );
    const allocatedState = confirmed!.state.state;
    expect(allocatedState.kind === 'allocated' && allocatedState.health.incarnation).toBe(
      'inc-created'
    );

    const stopped = decideAllocation(
      confirmed!.state,
      { type: 'CANCEL', scope: 'allocation', reason: 'cancel_allocation' },
      NOW
    );
    const notify = notifyCommandOf(stopped);
    expect(notify?.stopProof?.incarnation).toBe('inc-created');
    expect(notify?.stopProof?.incarnation).not.toBe(CREATE_INTENT.intentId);
    expect(notify?.stopProof).toEqual(
      destroyProof({ reason: 'cancel_allocation', incarnation: 'inc-created' })
    );
  });

  it('creating rejects CREATE_CONFIRMED with a stale fence', () => {
    expect(
      decideAllocation(
        creating(),
        {
          type: 'CREATE_CONFIRMED',
          fence: fence(operationId('create', 'other-intent')),
          providerRef: 'provider-ref-1',
          incarnation: 'inc-created',
          at: NOW,
        },
        NOW
      )
    ).toBeUndefined();
  });

  it('creating + CREATE_FAILED → stopped with no commands', () => {
    const decision = decideAllocation(
      creating(),
      {
        type: 'CREATE_FAILED',
        fence: fence(CREATE_OP),
        reason: 'no',
        at: NOW,
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopped');
    expect(decision?.commands).toEqual([]);
    expect(decision?.deadlineAt).toBeNull();
  });

  it('creating rejects CREATE_FAILED with a stale fence', () => {
    expect(
      decideAllocation(
        creating(),
        {
          type: 'CREATE_FAILED',
          fence: fence('create:wrong'),
          reason: 'no',
          at: NOW,
        },
        NOW
      )
    ).toBeUndefined();
  });

  it('creating + CREATE_UNKNOWN → unknown retaining the startup deadline, no Observe', () => {
    const decision = decideAllocation(
      creating(),
      {
        type: 'CREATE_UNKNOWN',
        fence: fence(CREATE_OP),
        reason: 'lost',
        at: NOW,
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('unknown');
    expect(commandKinds(decision)).toEqual([]);
    expect(decision?.deadlineAt).toBe(NOW + POLICY.createDeadlineMs);
  });

  it('creating + DEADLINE before the deadline is preserved', () => {
    const decision = decideAllocation(creating(), { type: 'DEADLINE' }, NOW);
    expect(decision?.state.state.kind).toBe('creating');
    expect(decision?.commands).toEqual([]);
    expect(decision?.deadlineAt).toBe(NOW + POLICY.createDeadlineMs);
  });

  it('creating + DEADLINE at the deadline → unknown', () => {
    const decision = decideAllocation(
      creating(),
      { type: 'DEADLINE' },
      NOW + POLICY.createDeadlineMs
    );
    expect(decision?.state.state.kind).toBe('unknown');
    expect(commandKinds(decision)).toEqual(['Observe']);
  });

  it('allocated + IDLE due and eligible → stopping.destroying with Destroy and notify', () => {
    const decision = decideAllocation(
      allocated({ kind: 'healthy' }, NOW - 1),
      { type: 'IDLE', idleAt: NOW - 1 },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopping');
    expect(commandKinds(decision)).toEqual(['Destroy', 'NotifySession']);
    expect(decision?.deadlineAt).toBe(NOW + POLICY.stopDeadlineMs);
  });

  it('allocated + IDLE in the future arms idleAt without stopping', () => {
    const decision = decideAllocation(
      allocated({ kind: 'healthy' }, null),
      { type: 'IDLE', idleAt: NOW + 60_000 },
      NOW
    );
    const state = decision?.state.state;
    expect(state?.kind === 'allocated' && state.idleAt).toBe(NOW + 60_000);
    expect(decision?.commands).toEqual([]);
  });

  it('allocated + IDLE while recovering is rejected (ineligible)', () => {
    expect(
      decideAllocation(
        allocated({ kind: 'recovering' }, NOW - 1),
        { type: 'IDLE', idleAt: NOW - 1 },
        NOW
      )
    ).toBeUndefined();
  });

  it('allocated + DEMAND clears the idle anchor', () => {
    const decision = decideAllocation(
      allocated({ kind: 'healthy' }, NOW + 5_000),
      {
        type: 'DEMAND',
        requestId: 'req-2',
        target: TARGET,
        createIntent: CREATE_INTENT,
      },
      NOW
    );
    const state = decision?.state.state;
    expect(state?.kind === 'allocated' && state.idleAt).toBeNull();
  });

  it('allocated + CANCEL{allocation} → stopping.destroying', () => {
    const decision = decideAllocation(
      allocated({ kind: 'healthy' }),
      { type: 'CANCEL', scope: 'allocation' },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopping');
    expect(commandKinds(decision)).toEqual(['Destroy', 'NotifySession']);
    expect(notifyCommandOf(decision)?.stopProof).toEqual(
      destroyProof({ reason: 'cancel_allocation' })
    );
  });

  it('allocated + CANCEL{recovery} while healthy is rejected (nothing to recover)', () => {
    expect(
      decideAllocation(allocated({ kind: 'healthy' }), { type: 'CANCEL', scope: 'recovery' }, NOW)
    ).toBeUndefined();
  });

  it('allocated + HEALTH_UNHEALTHY{absent} → stopped with a fenced proof notification', () => {
    const decision = decideAllocation(
      allocated({ kind: 'healthy' }),
      { type: 'HEALTH_UNHEALTHY', verdict: 'absent' },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopped');
    expect(commandKinds(decision)).toEqual(['NotifySession']);
    const command = decision?.commands[0];
    expect(command?.kind === 'NotifySession' && command.stopProof?.incarnation).toBe(INC);
    expect(decision?.deadlineAt).toBeNull();
  });

  it('allocated + HEALTH_UNHEALTHY{unresponsive} → stopping.destroying', () => {
    const decision = decideAllocation(
      allocated({ kind: 'healthy' }),
      { type: 'HEALTH_UNHEALTHY', verdict: 'unresponsive' },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopping');
    expect(commandKinds(decision)).toEqual(['Destroy', 'NotifySession']);
    const state = decision!.state.state;
    expect(state.kind === 'stopping' && state.stopIntent.reason).toContain('unresponsive');
    expect(state.kind === 'stopping' && state.stopIntent.incarnation).toBe(INC);
    expect(notifyCommandOf(decision)?.stopProof).toEqual(
      destroyProof({ reason: 'health_unhealthy_unresponsive' })
    );
  });

  it('allocated + CANCEL{recovery} gives recovery up → stopping.destroying', () => {
    const decision = decideAllocation(
      allocated({ kind: 'recovering' }),
      { type: 'CANCEL', scope: 'recovery' },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopping');
    expect(commandKinds(decision)).toEqual(['Destroy', 'NotifySession']);
    expect(notifyCommandOf(decision)?.stopProof).toEqual(
      destroyProof({ reason: 'health_unhealthy_unresponsive' })
    );
  });

  it('allocated + DEADLINE with idle due and eligible stops', () => {
    const decision = decideAllocation(
      allocated({ kind: 'healthy' }, NOW - 1),
      { type: 'DEADLINE' },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopping');
    expect(commandKinds(decision)).toEqual(['Destroy', 'NotifySession']);
    expect(notifyCommandOf(decision)?.stopProof).toEqual(destroyProof({ reason: 'idle' }));
  });

  it('allocated + DEADLINE while recovering past idleAt does not transition IDLE', () => {
    const decision = decideAllocation(
      allocated({ kind: 'recovering' }, NOW - 1),
      { type: 'DEADLINE' },
      NOW
    );
    expect(decision?.state.state.kind).toBe('allocated');
    expect(decision?.commands).toEqual([]);
  });

  it('preserves health recovery commands through allocation composition', () => {
    const decision = decideAllocation(
      allocated({ kind: 'healthy' }),
      {
        type: 'HEARTBEAT',
        incarnation: INC,
        at: NOW,
        ready: false,
        episodeId: EPISODE_ID,
      },
      NOW
    );
    const state = decision?.state.state;
    expect(state?.kind === 'allocated' && state.health.kind).toBe('recovering');
    expect(commandKinds(decision)).toEqual(['Reconcile']);
    const command = decision?.commands[0];
    expect(command?.kind === 'Reconcile' && command.attempt).toBe(1);
  });

  it('stopping.destroying + DESTROY_CONFIRMED → stopped with the proof', () => {
    const proof = destroyProof();
    const decision = decideAllocation(
      stoppingRecord(),
      {
        type: 'DESTROY_CONFIRMED',
        fence: fence(operationId('stop', NOW - 1_000, 0), 'provider-ref-1', INC),
        proof,
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopped');
    const command = decision?.commands[0];
    expect(command?.kind === 'NotifySession' && command.stopProof).toEqual(proof);
    expect(decision?.deadlineAt).toBeNull();
  });

  it('stopping.destroying rejects a stale DESTROY_CONFIRMED fence', () => {
    expect(
      decideAllocation(
        stoppingRecord(),
        {
          type: 'DESTROY_CONFIRMED',
          fence: fence('stop:stale', 'provider-ref-1'),
          proof: destroyProof(),
        },
        NOW
      )
    ).toBeUndefined();
  });

  it('stopping.destroying rejects a DESTROY_CONFIRMED proof with the wrong effect or incarnation', () => {
    const goodFence = fence(operationId('stop', NOW - 1_000, 0), 'provider-ref-1', INC);
    expect(
      decideAllocation(
        stoppingRecord(),
        {
          type: 'DESTROY_CONFIRMED',
          fence: goodFence,
          proof: destroyProof({ effect: 'stop' }),
        },
        NOW
      )
    ).toBeUndefined();
    expect(
      decideAllocation(
        stoppingRecord(),
        {
          type: 'DESTROY_CONFIRMED',
          fence: goodFence,
          proof: destroyProof({ incarnation: 'other-inc' }),
        },
        NOW
      )
    ).toBeUndefined();
  });

  it('stopping.destroying + DESTROY_NOT_CONFIRMED keeps the same absolute deadline', () => {
    const before = stoppingDestroying(0);
    const decision = decideAllocation(
      { v: 2, resumable: true, state: before },
      {
        type: 'DESTROY_NOT_CONFIRMED',
        fence: fence(operationId('stop', before.stopIntent.createdAt, 0), 'provider-ref-1', INC),
      },
      NOW
    );
    expect(decision?.state.state.kind === 'stopping' && decision.state.state.attempts).toBe(1);
    expect(decision?.deadlineAt).toBe(before.deadlineAt);
    expect(commandKinds(decision)).toEqual(['Destroy']);
  });

  it('stopping.destroying + DESTROY_NOT_CONFIRMED at budget → check_required with no timer', () => {
    const before = stoppingDestroying(POLICY.stopMaxAttempts - 1);
    const decision = decideAllocation(
      { v: 2, resumable: true, state: before },
      {
        type: 'DESTROY_NOT_CONFIRMED',
        fence: fence(
          operationId('stop', before.stopIntent.createdAt, before.attempts),
          'provider-ref-1',
          INC
        ),
      },
      NOW
    );
    expect(decision?.state.state.kind === 'stopping' && decision.state.state.step).toBe(
      'check_required'
    );
    expect(decision?.deadlineAt).toBeNull();
    expect(decision?.commands).toEqual([]);
  });

  it('stopping.destroying + BUDGET_EXHAUSTED → check_required', () => {
    const decision = decideAllocation(stoppingRecord(), { type: 'BUDGET_EXHAUSTED' }, NOW);
    expect(decision?.state.state.kind === 'stopping' && decision.state.state.step).toBe(
      'check_required'
    );
  });

  it('stopping.destroying + DEADLINE at the absolute deadline → check_required', () => {
    const decision = decideAllocation(
      stoppingRecord(),
      { type: 'DEADLINE' },
      NOW + POLICY.stopDeadlineMs
    );
    expect(decision?.state.state.kind === 'stopping' && decision.state.state.step).toBe(
      'check_required'
    );
    expect(decision?.commands).toEqual([]);
  });

  it('stopping.check_required + CHECK → destroying and emits Observe', () => {
    const decision = decideAllocation(checkRequired(), { type: 'CHECK' }, NOW);
    expect(decision?.state.state.kind === 'stopping' && decision.state.state.step).toBe(
      'destroying'
    );
    expect(commandKinds(decision)).toEqual(['Observe']);
    expect(decision?.deadlineAt).toBe(NOW + POLICY.stopDeadlineMs);
  });

  it('check_required CHECK completes: a present observation re-issues the destroy', () => {
    const checked = decideAllocation(checkRequired(), { type: 'CHECK' }, NOW)!;
    const state = checked.state.state;
    if (state.kind !== 'stopping' || state.step !== 'destroying')
      throw new Error('expected destroying');
    const decision = decideAllocation(
      checked.state,
      {
        type: 'OBSERVED',
        fence: fence(operationId('observe', state.stopIntent.createdAt), 'provider-ref-1', INC),
        result: 'present',
      },
      NOW + 1
    );
    expect(decision?.state.state.kind === 'stopping' && decision.state.state.step).toBe(
      'destroying'
    );
    expect(commandKinds(decision)).toEqual(['Destroy']);
  });

  it('check_required CHECK completes: an absent observation settles to stopped', () => {
    const checked = decideAllocation(checkRequired(), { type: 'CHECK' }, NOW)!;
    const state = checked.state.state;
    if (state.kind !== 'stopping' || state.step !== 'destroying')
      throw new Error('expected destroying');
    const decision = decideAllocation(
      checked.state,
      {
        type: 'OBSERVED',
        fence: fence(operationId('observe', state.stopIntent.createdAt), 'provider-ref-1', INC),
        result: 'absent',
      },
      NOW + 1
    );
    expect(decision?.state.state.kind).toBe('stopped');
    expect(commandKinds(decision)).toEqual(['NotifySession']);
    const proof = decision?.commands[0];
    expect(proof?.kind === 'NotifySession' && proof.stopProof?.incarnation).toBe(INC);
  });

  it('stopping.check_required + DEMAND → destroying and emits Destroy', () => {
    const decision = decideAllocation(
      checkRequired(),
      { type: 'DEMAND', requestId: 'req', target: TARGET, createIntent: CREATE_INTENT },
      NOW
    );
    expect(decision?.state.state.kind === 'stopping' && decision.state.state.step).toBe(
      'destroying'
    );
    expect(commandKinds(decision)).toEqual(['Destroy']);
  });

  it('stopping.check_required has no timer and rejects DEADLINE', () => {
    expect(
      decideAllocation(checkRequired(), { type: 'DEADLINE' }, NOW + 10_000_000)
    ).toBeUndefined();
  });

  it('unknown + OBSERVED absent → stopped', () => {
    const decision = decideAllocation(
      unknown(),
      {
        type: 'OBSERVED',
        fence: fence(operationId('observe', 'provider-ref-1'), 'provider-ref-1'),
        result: 'absent',
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopped');
    expect(decision?.commands).toEqual([]);
  });

  it('unknown + OBSERVED present → stopping.destroying', () => {
    const decision = decideAllocation(
      unknown(),
      {
        type: 'OBSERVED',
        fence: fence(operationId('observe', 'provider-ref-1'), 'provider-ref-1'),
        result: 'present',
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopping');
    expect(commandKinds(decision)).toEqual(['Destroy']);
  });

  it('unknown + OBSERVED present adopts a discovered reference and stops it', () => {
    const record: AllocationRecord = {
      v: 2,
      resumable: true,
      state: {
        kind: 'unknown',
        target: UNRESOLVED_TARGET,
        createIntent: CREATE_INTENT,
        stopIntent: null,
        attempts: 0,
        reason: 'create_deadline',
        deadlineAt: NOW + POLICY.observeDeadlineMs,
      },
    };
    const decision = decideAllocation(
      record,
      {
        type: 'OBSERVED',
        fence: fence(operationId('observe', CREATE_INTENT.intentId), 'discovered-ref'),
        result: 'present',
      },
      NOW
    );
    expect(decision?.state.state.kind).toBe('stopping');
    if (decision?.state.state.kind !== 'stopping') return;
    expect(decision.state.state.target.providerRef).toBe('discovered-ref');
    expect(commandKinds(decision)).toEqual(['Destroy']);
  });

  it('unknown rejects OBSERVED with a stale fence', () => {
    expect(
      decideAllocation(
        unknown(),
        {
          type: 'OBSERVED',
          fence: fence('observe:stale', 'provider-ref-1'),
          result: 'absent',
        },
        NOW
      )
    ).toBeUndefined();
  });

  it('unknown + DEADLINE before the retained deadline is inert', () => {
    const decision = decideAllocation(unknown(), { type: 'DEADLINE' }, NOW);
    expect(decision?.state).toEqual(unknown());
    expect(commandKinds(decision)).toEqual([]);
    expect(decision?.deadlineAt).toBe(NOW + POLICY.observeDeadlineMs);
  });

  it('unknown + DEADLINE at the retained deadline re-arms Observe', () => {
    const at = NOW + POLICY.observeDeadlineMs;
    const decision = decideAllocation(unknown(), { type: 'DEADLINE' }, at);
    expect(decision?.state.state.kind).toBe('unknown');
    expect(commandKinds(decision)).toEqual(['Observe']);
    expect(decision?.deadlineAt).toBe(at + POLICY.observeDeadlineMs);
  });

  function vercelUnknown(input: {
    createdAt: number | null;
    stopIntentCreatedAt?: number;
    deadlineAt: number;
  }): AllocationRecord {
    const createIntent =
      input.createdAt === null ? null : { intentId: 'intent-v', createdAt: input.createdAt };
    const stopIntent =
      input.stopIntentCreatedAt === undefined
        ? null
        : { reason: 'stop_deadline', createdAt: input.stopIntentCreatedAt };
    return {
      v: 2,
      resumable: true,
      state: {
        kind: 'unknown',
        target: VERCEL_TARGET,
        createIntent,
        stopIntent,
        attempts: 2,
        reason: 'stop_deadline',
        deadlineAt: input.deadlineAt,
      },
    };
  }

  it('vercel unknown + DEADLINE past the reconciliation window becomes check_required', () => {
    const anchor = NOW - 5_000;
    const at = anchor + POLICY.reconciliationWindowMs;
    const decision = decideAllocation(
      vercelUnknown({ createdAt: anchor, deadlineAt: NOW }),
      { type: 'DEADLINE' },
      at
    );
    expect(commandKinds(decision)).toEqual([]);
    expect(decision?.deadlineAt).toBeNull();
    expect(decision?.state.state.kind).toBe('stopping');
    if (decision?.state.state.kind !== 'stopping') return;
    expect(decision.state.state.step).toBe('check_required');
    expect(decision.state.state.attempts).toBe(2);
    expect(decision.state.state.stopIntent).toEqual({ reason: 'stop_deadline', createdAt: at });
  });

  it('vercel unknown anchors the cutoff on stopIntent.createdAt', () => {
    const stopAt = NOW - POLICY.reconciliationWindowMs;
    const decision = decideAllocation(
      vercelUnknown({ createdAt: NOW - 1_000, stopIntentCreatedAt: stopAt, deadlineAt: NOW }),
      { type: 'DEADLINE' },
      NOW
    );
    expect(commandKinds(decision)).toEqual([]);
    expect(decision?.state.state.kind).toBe('stopping');
    if (decision?.state.state.kind !== 'stopping') return;
    expect(decision.state.state.step).toBe('check_required');
    expect(decision.state.state.stopIntent).toEqual({
      reason: 'stop_deadline',
      createdAt: stopAt,
    });
  });

  it('cloudflare unknown at the same time still re-arms Observe', () => {
    const at = NOW - 5_000 + POLICY.reconciliationWindowMs;
    const record: AllocationRecord = {
      v: 2,
      resumable: true,
      state: {
        kind: 'unknown',
        target: TARGET,
        createIntent: CREATE_INTENT,
        stopIntent: null,
        attempts: 0,
        reason: 'stop_deadline',
        deadlineAt: NOW,
      },
    };
    const decision = decideAllocation(record, { type: 'DEADLINE' }, at);
    expect(decision?.state.state.kind).toBe('unknown');
    expect(commandKinds(decision)).toEqual(['Observe']);
    expect(decision?.deadlineAt).toBe(at + POLICY.observeDeadlineMs);
  });

  it('vercel unknown inside the reconciliation window still re-arms Observe', () => {
    const decision = decideAllocation(
      vercelUnknown({ createdAt: NOW - 5_000, deadlineAt: NOW }),
      { type: 'DEADLINE' },
      NOW
    );
    expect(decision?.state.state.kind).toBe('unknown');
    expect(commandKinds(decision)).toEqual(['Observe']);
    expect(decision?.deadlineAt).toBe(NOW + POLICY.observeDeadlineMs);
  });

  it('vercel unknown with no anchor keeps the observe ladder', () => {
    const decision = decideAllocation(
      vercelUnknown({ createdAt: null, deadlineAt: NOW }),
      { type: 'DEADLINE' },
      NOW + POLICY.reconciliationWindowMs * 2
    );
    expect(decision?.state.state.kind).toBe('unknown');
    expect(commandKinds(decision)).toEqual(['Observe']);
  });

  it('vercel unknown with a stop anchor but no createIntent keeps the observe ladder', () => {
    const decision = decideAllocation(
      vercelUnknown({
        createdAt: null,
        stopIntentCreatedAt: NOW - POLICY.reconciliationWindowMs,
        deadlineAt: NOW,
      }),
      { type: 'DEADLINE' },
      NOW
    );
    expect(decision?.state.state.kind).toBe('unknown');
    expect(commandKinds(decision)).toEqual(['Observe']);
  });

  it('unbound legacy unknown observes under the same fence OBSERVED accepts', () => {
    const record: AllocationRecord = {
      v: 2,
      resumable: true,
      state: {
        kind: 'unknown',
        target: UNRESOLVED_TARGET,
        createIntent: null,
        stopIntent: null,
        attempts: 0,
        reason: 'legacy_failed',
        deadlineAt: NOW,
      },
    };
    const deadline = decideAllocation(record, { type: 'DEADLINE' }, NOW);
    const observe = deadline?.commands.find(command => command.kind === 'Observe');
    const observeFence = operationId('observe', 'unknown');
    expect(observe?.kind === 'Observe' ? observe.operationId : undefined).toBe(observeFence);
    expect(
      decideAllocation(
        record,
        { type: 'OBSERVED', fence: fence(observeFence), result: 'absent' },
        NOW
      )?.state.state.kind
    ).toBe('stopped');
  });

  it('persistent providers take Stop, not Destroy', () => {
    const record: AllocationRecord = {
      v: 2,
      resumable: true,
      state: {
        kind: 'allocated',
        target: VERCEL_TARGET,
        createIntent: CREATE_INTENT,
        health: {
          kind: 'healthy',
          incarnation: INC,
          lastHeartbeat: { incarnation: INC, at: NOW, ready: true },
          deadlineAt: NOW + POLICY.heartbeatExpiryMs,
        },
        idleAt: null,
      },
    };
    const decision = decideAllocation(record, { type: 'CANCEL', scope: 'allocation' }, NOW);
    expect(commandKinds(decision)).toEqual(['Stop', 'NotifySession']);
  });

  it('every emitted command carries an operation id', () => {
    const decision = decideAllocation(
      stopped(),
      { type: 'DEMAND', requestId: 'req', target: TARGET, createIntent: CREATE_INTENT },
      NOW
    );
    for (const command of decision!.commands) {
      expect(command.operationId.length).toBeGreaterThan(0);
    }
  });

  it('declared commands match the emitted commands when entering stopping from allocated', () => {
    const cases: Array<{ record: AllocationRecord; event: AllocationInputEvent }> = [
      { record: allocated({ kind: 'healthy' }), event: { type: 'IDLE', idleAt: NOW } },
      { record: allocated({ kind: 'healthy' }), event: { type: 'CANCEL', scope: 'allocation' } },
      { record: allocated({ kind: 'healthy' }, NOW - 1), event: { type: 'DEADLINE' } },
    ];
    const normalize = (kinds: readonly string[]) => {
      const set = new Set(
        kinds.map(kind => (kind === 'Stop' || kind === 'Destroy' ? 'EFFECT' : kind))
      );
      return [...set].sort();
    };
    for (const { record, event } of cases) {
      const decision = decideAllocation(record, event, NOW)!;
      const declared = ALLOCATION_TRANSITIONS.find(
        transition =>
          transition.from === allocationStateKey(record.state) &&
          transition.event === event.type &&
          transition.to === allocationStateKey(decision.state.state)
      );
      expect(declared, `${event.type} from allocated`).toBeDefined();
      expect(normalize(decision.commands.map(command => command.kind))).toEqual(
        normalize(declared!.commands)
      );
    }
  });
});
