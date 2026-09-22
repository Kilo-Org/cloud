/**
 * Identity-correlated settled-reap evidence, collected from the local
 * `sandbox_control` records and asserted by the freeze scenarios. This is a pure
 * module: records in, evidence out, so the pass rule can be unit-tested without
 * Docker or the worker log.
 *
 * The record stream is first narrowed to the durable logical `sandboxId` the
 * caller read from `getSession`, then anchored on the reaped allocation's own
 * `allocationId`/`wrapperInstanceId` as reported by its settled
 * `physical_committed running -> stopping` record. The durable sandbox id is
 * stable across a replacement, so it alone cannot exclude the replacement; the
 * allocation anchor is what does. The accepted-reconciliation diagnostic carries
 * no `sandboxId`, so it is matched by its accepted message id instead. A missing
 * cause stays `null` and the assertion fails; the scenarios never infer a reap
 * from a null allocation observation alone.
 */

import type { LogRecord } from './idle-stop-evidence.js';

export type SandboxFaultReapEvidence = {
  /** The allocation reference the caller observed being reaped, echoed back. */
  reapedAllocationRef: string;
  /** Identity-matched `physical_committed running -> stopping` cause. */
  physicalStopCause: string | null;
  physicalStopStopCause: string | null;
  physicalStopFromState: string | null;
  physicalStopToState: string | null;
  /** True when an identity-matched terminal `provider_stop` was observed. */
  providerStopObserved: boolean;
  /** True when an identity-matched `deadline_fired deadlineId=heartbeatExpiry` was observed. */
  heartbeatExpiryDeadline: boolean;
  /** First identity-matched started `recovery_outcome` cause/outcome. */
  recoveryCause: string | null;
  recoveryOutcome: string | null;
  /** True when an identity-matched `wrapper_ready` followed the fault (a veto). */
  wrapperReadyAfterFault: boolean;
  /** Identity-matched finished `accepted_reconciliation` result for the held message. */
  acceptedReconciliation: string | null;
  /** True when an identity-matched heartbeat reported the route `active`. */
  routeStaleActive: boolean;
};

export function emptyReapEvidence(reapedAllocationRef: string): SandboxFaultReapEvidence {
  return {
    reapedAllocationRef,
    physicalStopCause: null,
    physicalStopStopCause: null,
    physicalStopFromState: null,
    physicalStopToState: null,
    providerStopObserved: false,
    heartbeatExpiryDeadline: false,
    recoveryCause: null,
    recoveryOutcome: null,
    wrapperReadyAfterFault: false,
    acceptedReconciliation: null,
    routeStaleActive: false,
  };
}

function stringField(record: LogRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function collectReapEvidence(
  records: Iterable<LogRecord>,
  input: { reapedAllocationRef: string; sandboxId: string; messageId?: string }
): SandboxFaultReapEvidence {
  const evidence = emptyReapEvidence(input.reapedAllocationRef);
  const matched = [...records].filter(
    record =>
      record.sandboxId === input.sandboxId ||
      // The accepted-reconciliation diagnostic carries no `sandboxId`; its
      // identity is the accepted message id.
      (record.diagnosticEvent === 'accepted_reconciliation' &&
        input.messageId !== undefined &&
        record.messageId === input.messageId)
  );

  // The durable `sandboxId` is stable across an allocation replacement, so it
  // is not enough on its own: a replacement's `wrapper_ready`/heartbeat would
  // read as a veto. Anchor on the reaped allocation's own identity from the
  // settled commit, then ignore records that name a different allocation or
  // wrapper instance.
  let stopAllocationId: string | null = null;
  let stopWrapperInstanceId: string | null = null;
  for (const record of matched) {
    if (
      record.diagnosticEvent === 'physical_committed' &&
      record.fromState === 'running' &&
      record.toState === 'stopping'
    ) {
      stopAllocationId = stringField(record, 'allocationId');
      stopWrapperInstanceId = stringField(record, 'wrapperInstanceId');
      evidence.physicalStopCause = stringField(record, 'cause');
      evidence.physicalStopStopCause = stringField(record, 'stopCause');
      evidence.physicalStopFromState = stringField(record, 'fromState');
      evidence.physicalStopToState = stringField(record, 'toState');
      break;
    }
  }

  const belongsToStop = (record: LogRecord): boolean => {
    const allocationId = record.allocationId;
    if (
      stopAllocationId !== null &&
      typeof allocationId === 'string' &&
      allocationId !== stopAllocationId
    ) {
      return false;
    }
    const wrapperInstanceId = record.wrapperInstanceId;
    if (
      stopWrapperInstanceId !== null &&
      typeof wrapperInstanceId === 'string' &&
      wrapperInstanceId !== stopWrapperInstanceId
    ) {
      return false;
    }
    return true;
  };

  // The latest identity-matched target-route heartbeat state, not an
  // accumulated "ever active" boolean: the cursor is captured before the send,
  // so an earlier active heartbeat followed by an idle one must not read as a
  // stale-active route.
  let latestRouteState: string | null = null;

  for (const record of matched) {
    if (!belongsToStop(record)) continue;
    const diagnosticEvent = record.diagnosticEvent;
    if (diagnosticEvent === 'provider_stop') {
      if (record.result === 'terminal') evidence.providerStopObserved = true;
    } else if (diagnosticEvent === 'deadline_fired') {
      if (record.deadlineId === 'heartbeatExpiry') evidence.heartbeatExpiryDeadline = true;
    } else if (diagnosticEvent === 'recovery_outcome') {
      const outcome = stringField(record, 'outcome');
      if (evidence.recoveryOutcome === null || outcome === 'started') {
        evidence.recoveryCause = stringField(record, 'cause');
        evidence.recoveryOutcome = outcome;
      }
    } else if (diagnosticEvent === 'wrapper_ready') {
      evidence.wrapperReadyAfterFault = true;
    } else if (diagnosticEvent === 'heartbeat') {
      latestRouteState = stringField(record, 'sessionState');
    } else if (
      diagnosticEvent === 'accepted_reconciliation' &&
      input.messageId !== undefined &&
      record.messageId === input.messageId &&
      record.result === 'runtime_unhealthy'
    ) {
      // `phase=started`/`finished` is not part of this record's extracted
      // fields; the terminal `result` plus the exact message id is the identity.
      evidence.acceptedReconciliation = 'runtime_unhealthy';
    }
  }
  evidence.routeStaleActive = latestRouteState === 'active';
  return evidence;
}

/**
 * Require the identity-correlated pass rule for a settled reap. A distinct
 * replacement is necessary but not sufficient: the evidence must name the
 * settled-reap cause on the physical stop, a terminal provider stop, the
 * heartbeat-expiry recovery, no re-ready wrapper, and (inflight only) the
 * `runtime_unhealthy` reconciliation plus a still-active route. Rejecting a
 * null cause is the point: a run that merely lost the allocation and got a
 * replacement must not pass.
 */
export function assertReapOutcome(input: {
  evidence: SandboxFaultReapEvidence;
  reapedAllocationRef: string;
  replacementAllocationRef: string;
  settledReapReason: string;
  inflight: boolean;
}): void {
  const { evidence } = input;
  if (evidence.reapedAllocationRef !== input.reapedAllocationRef) {
    throw new Error(
      `reap evidence is for ${evidence.reapedAllocationRef}; expected ${input.reapedAllocationRef}`
    );
  }
  if (input.replacementAllocationRef === input.reapedAllocationRef) {
    throw new Error(
      `no distinct replacement: the same allocation ${input.reapedAllocationRef} still serves the session`
    );
  }
  if (evidence.physicalStopFromState !== 'running' || evidence.physicalStopToState !== 'stopping') {
    throw new Error(
      `no identity-matched running -> stopping physical commit (from=${evidence.physicalStopFromState ?? 'none'}; to=${evidence.physicalStopToState ?? 'none'})`
    );
  }
  if (
    evidence.physicalStopCause !== input.settledReapReason ||
    evidence.physicalStopStopCause !== input.settledReapReason
  ) {
    throw new Error(
      `physical stop cause=${evidence.physicalStopCause ?? 'none'}/stopCause=${evidence.physicalStopStopCause ?? 'none'}; expected ${input.settledReapReason}`
    );
  }
  if (!evidence.providerStopObserved) {
    throw new Error('no identity-matched terminal provider_stop was observed');
  }
  if (!evidence.heartbeatExpiryDeadline) {
    throw new Error('no identity-matched deadline_fired deadlineId=heartbeatExpiry was observed');
  }
  if (evidence.recoveryCause !== 'heartbeat_expired' || evidence.recoveryOutcome !== 'started') {
    throw new Error(
      `recovery outcome cause=${evidence.recoveryCause ?? 'none'}/outcome=${evidence.recoveryOutcome ?? 'none'}; expected heartbeat_expired/started`
    );
  }
  if (evidence.wrapperReadyAfterFault) {
    throw new Error('an identity-matched wrapper_ready followed the fault; the reap was vetoed');
  }
  if (input.inflight) {
    if (evidence.acceptedReconciliation !== 'runtime_unhealthy') {
      throw new Error(
        `accepted reconciliation=${evidence.acceptedReconciliation ?? 'none'}; expected runtime_unhealthy`
      );
    }
    if (!evidence.routeStaleActive) {
      throw new Error('no identity-matched active heartbeat for the frozen route');
    }
  }
}
