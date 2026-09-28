/**
 * The only clock. Composes the single scheduled deadline per aggregate from
 * eligible anchors (plan §5). It never reads a clock; callers pass `now`.
 *
 * Policy values mirror the current `DEADLINE_MS` / protocol constants. They are
 * copied rather than imported so the core stays self-contained while the legacy
 * modules are still present.
 */
import type { AllocationRecord } from './model/allocation.js';
import type { HealthState } from './model/health.js';
import type { SessionAggregate } from './model/session.js';

export const POLICY = {
  /** DEADLINE_MS.startup */
  createDeadlineMs: 2 * 60_000,
  /** DEADLINE_MS.wrapperReadiness */
  connectingDeadlineMs: 90_000,
  /** DEADLINE_MS.heartbeatExpiry */
  heartbeatExpiryMs: 90_000,
  /** SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS × SANDBOX_CONTROL_RECOVERY_ATTEMPT_TIMEOUT_MS */
  recoveryDeadlineMs: 3 * 30_000,
  recoveryMaxAttempts: 3,
  /** Replaces the deleted `reconciliation` observe loop. */
  observeDeadlineMs: 90_000,
  /** DEADLINE_MS.reconciliationWindow */
  reconciliationWindowMs: 60 * 60_000,
  /** DEADLINE_MS.stopAttemptLadder sum plus margin. */
  stopDeadlineMs: 60_000,
  stopMaxAttempts: 5,
  /** DEADLINE_MS.idleStop */
  idleStopMs: 10 * 60_000,
  /** DEADLINE_MS.acceptedAlarmCap */
  acceptedAlarmCapMs: 30_000,
  /** Accepted-work recheck cadence, mirroring `acceptedAlarmCap`. */
  acceptedRecheckMs: 30_000,
  /** SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS: the hard accepted-work execution bound. */
  acceptedExecutionBoundMs: 60 * 60_000,
  /** SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS: how long an ambiguous cancel may reconcile. */
  cancellationDeadlineMs: 10_000,
  deliveryRetryMs: 5_000,
} as const;

export function healthDeadlineAt(health: HealthState): number | null {
  return health.kind === 'unhealthy' ? null : health.deadlineAt;
}

/**
 * Idle stopping is eligible only while there is no pinned work and the runtime is
 * `healthy`/`connecting`. While recovering (or terminal) the idle anchor is
 * retained as policy data but is not scheduled, so recovery starting just before
 * idle expiry cannot leave a past-due minimum selected on every alarm.
 */
export function idleStopEligible(health: HealthState): boolean {
  return health.kind === 'healthy' || health.kind === 'connecting';
}

function allocatedAlarmAt(health: HealthState, idleAt: number | null): number | null {
  const healthDeadline = healthDeadlineAt(health);
  if (!idleStopEligible(health) || idleAt === null) return healthDeadline;
  if (healthDeadline === null) return idleAt;
  return Math.min(healthDeadline, idleAt);
}

export function allocationAlarmAt(record: AllocationRecord): number | null {
  const { state } = record;
  switch (state.kind) {
    case 'stopped':
      return null;
    case 'creating':
      return state.deadlineAt;
    case 'allocated':
      return allocatedAlarmAt(state.health, state.idleAt);
    case 'stopping':
      return state.step === 'destroying' ? state.deadlineAt : null;
    case 'unknown':
      return state.deadlineAt;
  }
}

/** The session aggregate's single deadline: earliest live message deadline. */
export function sessionAlarmAt(aggregate: SessionAggregate): number | null {
  const candidates: number[] = [];
  for (const message of aggregate.messages) {
    const { state } = message;
    if (state.kind === 'queued') {
      if (state.deadlineAt !== null) candidates.push(state.deadlineAt);
      if (state.retryNotBefore !== undefined) candidates.push(state.retryNotBefore);
    } else if (state.kind === 'accepted') {
      candidates.push(state.executionDeadlineAt);
      if (state.capAt !== undefined) candidates.push(state.capAt);
    }
    if (state.kind === 'queued' || state.kind === 'accepted') {
      if (message.cancellation !== undefined) candidates.push(message.cancellation.deadlineAt);
    }
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}
