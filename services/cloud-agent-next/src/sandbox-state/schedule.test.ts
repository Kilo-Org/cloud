import { describe, expect, it } from 'vitest';
import {
  POLICY,
  allocationAlarmAt,
  healthDeadlineAt,
  idleStopEligible,
  sessionAlarmAt,
} from './schedule.js';
import { decideAllocation } from './allocation/reduce.js';
import { operationId } from './commands.js';
import type { AllocationRecord, StoppingCheckRequired } from './model/allocation.js';
import type { HealthState } from './model/health.js';
import type { SessionAggregate } from './model/session.js';

const NOW = 7_000_000;
const INC = 'inc-1';
const EPISODE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET = {
  provider: 'cloudflare' as const,
  providerRef: 'ref',
  capabilities: { persistentWorkspace: false, destroysOnStop: true },
};
const INTENT = { intentId: 'intent-1', createdAt: NOW - 10_000 };

function allocated(health: HealthState, idleAt: number | null): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: { kind: 'allocated', target: TARGET, createIntent: INTENT, health, idleAt },
  };
}

function healthy(deadlineAt: number): HealthState {
  return {
    kind: 'healthy',
    incarnation: INC,
    lastHeartbeat: { incarnation: INC, at: NOW, ready: true },
    deadlineAt,
  };
}

describe('scheduler — one deadline per aggregate', () => {
  it('has no timer while stopped and no timer for stopping.check_required', () => {
    expect(
      allocationAlarmAt({ v: 2, resumable: true, state: { kind: 'stopped', summary: null } })
    ).toBeNull();
    const checkRequired: StoppingCheckRequired = {
      kind: 'stopping',
      target: TARGET,
      createIntent: INTENT,
      stopIntent: { reason: 'x', createdAt: NOW },
      step: 'check_required',
      attempts: 0,
    };
    const record: AllocationRecord = { v: 2, resumable: true, state: checkRequired };
    expect(allocationAlarmAt(record)).toBeNull();
    expect(decideAllocation(record, { type: 'DEADLINE' }, NOW + 10_000_000)).toBeUndefined();
  });

  it('composes min(health deadline, idle anchor) while idle stopping is eligible', () => {
    const healthDeadline = NOW + 10_000;
    const idleAt = NOW + 5_000;
    const record = allocated(healthy(healthDeadline), idleAt);
    expect(allocationAlarmAt(record)).toBe(idleAt);
    expect(
      idleStopEligible(
        record.state.kind === 'allocated' ? record.state.health : ({} as HealthState)
      )
    ).toBe(true);
  });

  it('fires an already-expired eligible idle anchor', () => {
    const record = allocated(healthy(NOW + 10_000), NOW - 1);
    expect(allocationAlarmAt(record)).toBe(NOW - 1);
  });

  it('ignores the idle anchor while recovering', () => {
    const recovering: HealthState = {
      kind: 'recovering',
      incarnation: INC,
      step: 'check_sandbox',
      attempts: 1,
      deadlineAt: NOW + POLICY.recoveryDeadlineMs,
      episodeId: EPISODE_ID,
      cause: 'activation_pending',
    };
    const record = allocated(recovering, NOW - 1);
    expect(allocationAlarmAt(record)).toBe(NOW + POLICY.recoveryDeadlineMs);
    expect(idleStopEligible(recovering)).toBe(false);
  });

  it('healthDeadlineAt is null only for unhealthy', () => {
    expect(healthDeadlineAt({ kind: 'unhealthy', incarnation: INC, verdict: 'absent' })).toBeNull();
    expect(healthDeadlineAt(healthy(NOW))).toBe(NOW);
  });

  it('sessionAlarmAt returns the earliest live message deadline', () => {
    const aggregate: SessionAggregate = {
      binding: { kind: 'unbound' },
      messages: [
        {
          messageId: 'm1',
          state: {
            kind: 'queued',
            intent: null,
            legacyInvalidIntent: true,
            deliveryStep: 'waiting',
            deadlineAt: NOW + 5_000,
            attachFailures: 0,
            promptFailures: 0,
          },
        },
        {
          messageId: 'm2',
          state: {
            kind: 'accepted',
            intent: null,
            legacyInvalidIntent: true,
            acceptedAt: NOW,
            executionDeadlineAt: NOW + 1_000,
          },
        },
      ],
    };
    expect(sessionAlarmAt(aggregate)).toBe(NOW + 1_000);
    expect(sessionAlarmAt({ binding: { kind: 'unbound' }, messages: [] })).toBeNull();
  });
});

describe('scheduler regression — recovery just before idle expiry', () => {
  it('does not arm an immediate or repeated alarm and does not transition IDLE while ineligible', () => {
    const healthDeadline = NOW + 10_000;
    const idleAt = NOW + 1;
    const before = allocated(healthy(healthDeadline), idleAt);
    expect(allocationAlarmAt(before)).toBe(idleAt);

    const recovering = decideAllocation(
      before,
      { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: false, episodeId: EPISODE_ID },
      NOW
    );
    expect(recovering).toBeDefined();
    const recoveringRecord = recovering!.state;
    const health =
      recoveringRecord.state.kind === 'allocated' ? recoveringRecord.state.health : undefined;
    expect(health?.kind).toBe('recovering');

    const recoveryAlarm = allocationAlarmAt(recoveringRecord);
    expect(recoveryAlarm).toBe(NOW + POLICY.recoveryDeadlineMs);
    expect(recoveryAlarm).toBeGreaterThan(NOW);
    expect(recoveryAlarm).not.toBe(idleAt);

    const deadline = decideAllocation(recoveringRecord, { type: 'DEADLINE' }, NOW + 1_000);
    expect(deadline?.state.state.kind).toBe('allocated');
    expect(deadline?.commands).toEqual([]);
    expect(deadline?.state.state.kind === 'allocated' && deadline.state.state.health.kind).toBe(
      'recovering'
    );

    expect(
      decideAllocation(recoveringRecord, { type: 'IDLE', idleAt }, NOW + 1_000)
    ).toBeUndefined();

    const recovered = decideAllocation(
      recoveringRecord,
      {
        type: 'RECOVERY_SUCCEEDED',
        fence: {
          incarnation: INC,
          episodeId: EPISODE_ID,
          attempt: 1,
          operationId: operationId('reconcile', INC, EPISODE_ID, 1),
        },
        at: NOW + 30_000,
        ready: true,
      },
      NOW + 30_000
    );
    const recoveredRecord = recovered!.state;
    expect(recoveredRecord.state.kind === 'allocated' && recoveredRecord.state.idleAt).toBe(idleAt);
    const recoveredAlarm = allocationAlarmAt(recoveredRecord);
    expect(recoveredAlarm).toBe(idleAt);
    expect(recoveredAlarm!).toBeLessThanOrEqual(NOW + 30_000);

    const idle = decideAllocation(recoveredRecord, { type: 'IDLE', idleAt }, NOW + 30_000);
    expect(idle?.state.state.kind).toBe('stopping');
    expect(idle?.commands.map(command => command.kind)).toEqual(['Destroy', 'NotifySession']);
  });
});
