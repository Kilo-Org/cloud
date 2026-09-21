import { describe, expect, it } from 'vitest';

import {
  assertReapOutcome,
  collectReapEvidence,
  emptyReapEvidence,
  type SandboxFaultReapEvidence,
} from '../../e2e/sandbox-fault-evidence.js';
import type { LogRecord } from '../../e2e/idle-stop-evidence.js';

const SANDBOX = 'workspace_sandbox_a';
const REAPED = 'container-old';
const REPLACEMENT = 'container-new';
const MESSAGE = 'msg_held';

function settledRecords(inflight: boolean): LogRecord[] {
  return [
    {
      logTag: 'sandbox_control',
      diagnosticEvent: 'physical_committed',
      sandboxId: SANDBOX,
      allocationId: 'alloc-old',
      wrapperInstanceId: 'wrapper-old',
      fromState: 'running',
      toState: 'stopping',
      cause: 'recovery_settled_reap',
      stopCause: 'recovery_settled_reap',
    },
    {
      logTag: 'sandbox_control',
      diagnosticEvent: 'provider_stop',
      sandboxId: SANDBOX,
      result: 'terminal',
    },
    {
      logTag: 'sandbox_control',
      diagnosticEvent: 'deadline_fired',
      sandboxId: SANDBOX,
      deadlineId: 'heartbeatExpiry',
    },
    {
      logTag: 'sandbox_control',
      diagnosticEvent: 'recovery_outcome',
      sandboxId: SANDBOX,
      cause: 'heartbeat_expired',
      outcome: 'started',
    },
    ...(inflight
      ? [
          {
            logTag: 'sandbox_control',
            diagnosticEvent: 'accepted_reconciliation',
            sessionId: SANDBOX,
            phase: 'finished',
            messageId: MESSAGE,
            expectedWrapperInstanceId: 'wrapper-old',
            result: 'runtime_unhealthy',
          },
          {
            logTag: 'sandbox_control',
            diagnosticEvent: 'heartbeat',
            sandboxId: SANDBOX,
            sessionState: 'active',
          },
        ]
      : []),
  ];
}

function collect(records: LogRecord[], inflight = false): SandboxFaultReapEvidence {
  return collectReapEvidence(records, {
    reapedAllocationRef: REAPED,
    sandboxId: SANDBOX,
    ...(inflight ? { messageId: MESSAGE } : {}),
  });
}

function heartbeat(state: string): LogRecord {
  return {
    logTag: 'sandbox_control',
    diagnosticEvent: 'heartbeat',
    sandboxId: SANDBOX,
    allocationId: 'alloc-old',
    wrapperInstanceId: 'wrapper-old',
    sessionState: state,
  };
}

describe('collectReapEvidence', () => {
  it('collects the settled-reap, provider stop, heartbeat expiry and recovery', () => {
    const evidence = collect(settledRecords(false));
    expect(evidence.physicalStopCause).toBe('recovery_settled_reap');
    expect(evidence.physicalStopStopCause).toBe('recovery_settled_reap');
    expect(evidence.physicalStopFromState).toBe('running');
    expect(evidence.physicalStopToState).toBe('stopping');
    expect(evidence.providerStopObserved).toBe(true);
    expect(evidence.heartbeatExpiryDeadline).toBe(true);
    expect(evidence.recoveryCause).toBe('heartbeat_expired');
    expect(evidence.recoveryOutcome).toBe('started');
    expect(evidence.wrapperReadyAfterFault).toBe(false);
  });

  it('ignores records for a different durable sandbox id', () => {
    const evidence = collect(
      settledRecords(false).map(record => ({ ...record, sandboxId: 'workspace_other' }))
    );
    expect(evidence.physicalStopCause).toBeNull();
    expect(evidence.providerStopObserved).toBe(false);
  });

  it('records a re-ready wrapper as a veto', () => {
    const evidence = collect([
      ...settledRecords(false),
      { logTag: 'sandbox_control', diagnosticEvent: 'wrapper_ready', sandboxId: SANDBOX },
    ]);
    expect(evidence.wrapperReadyAfterFault).toBe(true);
  });

  it('ignores a replacement wrapper that shares the durable sandbox id', () => {
    const evidence = collect([
      ...settledRecords(false),
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'wrapper_ready',
        sandboxId: SANDBOX,
        allocationId: 'alloc-new',
        wrapperInstanceId: 'wrapper-new',
      },
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'heartbeat',
        sandboxId: SANDBOX,
        allocationId: 'alloc-new',
        wrapperInstanceId: 'wrapper-new',
        sessionState: 'active',
      },
    ]);
    expect(evidence.wrapperReadyAfterFault).toBe(false);
    expect(evidence.routeStaleActive).toBe(false);
  });

  it('matches the inflight reconciliation to the held message only', () => {
    const evidence = collect(settledRecords(true), true);
    expect(evidence.acceptedReconciliation).toBe('runtime_unhealthy');
    expect(evidence.routeStaleActive).toBe(true);
  });

  it('tracks the latest heartbeat state, not an accumulated active flag', () => {
    expect(collect([...settledRecords(true), heartbeat('idle')], true).routeStaleActive).toBe(
      false
    );
    const idleThenActive = collect(
      [
        ...settledRecords(true).filter(record => record.diagnosticEvent !== 'heartbeat'),
        heartbeat('idle'),
        heartbeat('active'),
      ],
      true
    );
    expect(idleThenActive.routeStaleActive).toBe(true);
  });
});

describe('assertReapOutcome', () => {
  it('accepts a full settled-reap run with a distinct replacement', () => {
    expect(() =>
      assertReapOutcome({
        evidence: collect(settledRecords(false)),
        reapedAllocationRef: REAPED,
        replacementAllocationRef: REPLACEMENT,
        settledReapReason: 'recovery_settled_reap',
        inflight: false,
      })
    ).not.toThrow();
  });

  it('accepts a full inflight-reap run', () => {
    expect(() =>
      assertReapOutcome({
        evidence: collect(settledRecords(true), true),
        reapedAllocationRef: REAPED,
        replacementAllocationRef: REPLACEMENT,
        settledReapReason: 'recovery_settled_reap',
        inflight: true,
      })
    ).not.toThrow();
  });

  it('rejects an inflight run whose matching route went active then idle', () => {
    expect(() =>
      assertReapOutcome({
        evidence: collect([...settledRecords(true), heartbeat('idle')], true),
        reapedAllocationRef: REAPED,
        replacementAllocationRef: REPLACEMENT,
        settledReapReason: 'recovery_settled_reap',
        inflight: true,
      })
    ).toThrow(/no identity-matched active heartbeat/);
  });

  it('accepts an inflight run whose matching route went idle then active', () => {
    const evidence = collect(
      [
        ...settledRecords(true).filter(record => record.diagnosticEvent !== 'heartbeat'),
        heartbeat('idle'),
        heartbeat('active'),
      ],
      true
    );
    expect(() =>
      assertReapOutcome({
        evidence,
        reapedAllocationRef: REAPED,
        replacementAllocationRef: REPLACEMENT,
        settledReapReason: 'recovery_settled_reap',
        inflight: true,
      })
    ).not.toThrow();
  });

  it('rejects a distinct replacement with ordinary idle-stop evidence', () => {
    const idle = collect([
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'physical_committed',
        sandboxId: SANDBOX,
        fromState: 'running',
        toState: 'stopping',
        cause: 'idle',
        stopCause: 'idle',
      },
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'provider_stop',
        sandboxId: SANDBOX,
        result: 'terminal',
      },
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'deadline_fired',
        sandboxId: SANDBOX,
        deadlineId: 'idleStop',
      },
      {
        logTag: 'sandbox_control',
        diagnosticEvent: 'recovery_outcome',
        sandboxId: SANDBOX,
        cause: 'idle',
        outcome: 'started',
      },
    ]);
    expect(() =>
      assertReapOutcome({
        evidence: idle,
        reapedAllocationRef: REAPED,
        replacementAllocationRef: REPLACEMENT,
        settledReapReason: 'recovery_settled_reap',
        inflight: false,
      })
    ).toThrow(/expected recovery_settled_reap/);
  });

  it('rejects a null observation even when a replacement exists', () => {
    expect(() =>
      assertReapOutcome({
        evidence: emptyReapEvidence(REAPED),
        reapedAllocationRef: REAPED,
        replacementAllocationRef: REPLACEMENT,
        settledReapReason: 'recovery_settled_reap',
        inflight: false,
      })
    ).toThrow(/no identity-matched|expected recovery_settled_reap/);
  });

  it('rejects when the replacement is not distinct', () => {
    expect(() =>
      assertReapOutcome({
        evidence: collect(settledRecords(false)),
        reapedAllocationRef: REAPED,
        replacementAllocationRef: REAPED,
        settledReapReason: 'recovery_settled_reap',
        inflight: false,
      })
    ).toThrow(/no distinct replacement/);
  });

  it('rejects an inflight run without the runtime_unhealthy reconciliation', () => {
    expect(() =>
      assertReapOutcome({
        evidence: collect(settledRecords(false)),
        reapedAllocationRef: REAPED,
        replacementAllocationRef: REPLACEMENT,
        settledReapReason: 'recovery_settled_reap',
        inflight: true,
      })
    ).toThrow(/expected runtime_unhealthy/);
  });
});
