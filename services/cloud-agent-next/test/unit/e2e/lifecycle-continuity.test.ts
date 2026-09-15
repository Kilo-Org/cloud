import { describe, expect, it } from 'vitest';

import {
  classifyFault,
  isSettledReapStopRecord,
  matchesConnection,
  matchesReconciliationIdentity,
  type ConnectionIdentity,
} from '../../e2e/lifecycle-continuity.js';
import {
  RECOVERY_CLEANUP_REASON,
  RECOVERY_SETTLED_REAP_REASON,
} from '../../../src/sandbox-control/recovery-cleanup.js';
import type { LogRecord } from '../../e2e/idle-stop-evidence.js';

const TARGET: ConnectionIdentity = {
  sandboxId: 'ses_target',
  connectionId: 'conn_target',
  wrapperInstanceId: 'wrapper_target',
};

function control(record: LogRecord): LogRecord {
  return { logTag: 'sandbox_control', ...record };
}

function heartbeat(sandboxId: string, connectionId: string, wrapperInstanceId: string): LogRecord {
  return control({ diagnosticEvent: 'heartbeat', sandboxId, connectionId, wrapperInstanceId });
}

function deadline(sandboxId: string, connectionId: string, wrapperInstanceId: string): LogRecord {
  return control({
    diagnosticEvent: 'deadline_fired',
    deadlineId: 'heartbeatExpiry',
    sandboxId,
    connectionId,
    wrapperInstanceId,
  });
}

function recovery(
  sandboxId: string,
  connectionId: string,
  wrapperInstanceId: string,
  cause: string,
  outcome: 'started' | 'skipped'
): LogRecord {
  return control({
    diagnosticEvent: 'recovery_outcome',
    cause,
    outcome,
    sandboxId,
    connectionId,
    wrapperInstanceId,
  });
}

describe('matchesConnection', () => {
  it('requires the matching sandbox plus both connection and wrapper instance', () => {
    const partial = control({
      diagnosticEvent: 'heartbeat',
      sandboxId: TARGET.sandboxId,
      connectionId: TARGET.connectionId,
    });
    expect(matchesConnection(partial, TARGET)).toBe(false);
    expect(matchesConnection(heartbeat(TARGET.sandboxId, 'other', 'other'), TARGET)).toBe(false);
    expect(
      matchesConnection(
        heartbeat(TARGET.sandboxId, TARGET.connectionId, TARGET.wrapperInstanceId),
        TARGET
      )
    ).toBe(true);
  });
});

describe('matchesReconciliationIdentity', () => {
  const target = {
    messageId: 'message-target',
    sessionId: 'session-target',
    wrapperInstanceId: 'wrapper-target',
  };

  it('rejects a record whose message id is absent', () => {
    expect(
      matchesReconciliationIdentity(
        control({
          diagnosticEvent: 'accepted_reconciliation',
          sessionId: target.sessionId,
          expectedWrapperInstanceId: target.wrapperInstanceId,
        }),
        target
      )
    ).toBe(false);
  });

  it('rejects another session record for a different message id', () => {
    expect(
      matchesReconciliationIdentity(
        control({
          messageId: 'message-other',
          sessionId: 'session-other',
          expectedWrapperInstanceId: 'wrapper-other',
        }),
        target
      )
    ).toBe(false);
  });

  it('requires the exact message id and constrains retained session/wrapper identity', () => {
    expect(matchesReconciliationIdentity(control({ messageId: target.messageId }), target)).toBe(
      true
    );
    expect(
      matchesReconciliationIdentity(
        control({ messageId: target.messageId, sessionId: 'session-other' }),
        target
      )
    ).toBe(false);
    expect(
      matchesReconciliationIdentity(
        control({ messageId: target.messageId, expectedWrapperInstanceId: 'wrapper-other' }),
        target
      )
    ).toBe(false);
    expect(
      matchesReconciliationIdentity(
        control({
          messageId: target.messageId,
          sessionId: target.sessionId,
          expectedWrapperInstanceId: target.wrapperInstanceId,
        }),
        target
      )
    ).toBe(true);
  });
});

describe('isSettledReapStopRecord', () => {
  const sandboxId = 'ses_target';
  const settledStop = (overrides: LogRecord = {}): LogRecord =>
    control({
      diagnosticEvent: 'physical_committed',
      sandboxId,
      fromState: 'running',
      toState: 'stopping',
      cause: RECOVERY_SETTLED_REAP_REASON,
      stopCause: RECOVERY_SETTLED_REAP_REASON,
      ...overrides,
    });

  it('requires the tombstone reason in both cause and stopCause', () => {
    expect(isSettledReapStopRecord(settledStop(), sandboxId)).toBe(true);
    expect(isSettledReapStopRecord(settledStop({ stopCause: undefined }), sandboxId)).toBe(false);
    expect(isSettledReapStopRecord(settledStop({ cause: undefined }), sandboxId)).toBe(false);
    expect(
      isSettledReapStopRecord(settledStop({ cause: RECOVERY_CLEANUP_REASON }), sandboxId)
    ).toBe(false);
  });

  it('requires the running -> stopping transition for this sandbox', () => {
    expect(isSettledReapStopRecord(settledStop({ fromState: 'stopping' }), sandboxId)).toBe(false);
    expect(isSettledReapStopRecord(settledStop({ sandboxId: 'ses_other' }), sandboxId)).toBe(false);
    expect(
      isSettledReapStopRecord(
        control({
          diagnosticEvent: 'stop_attempt',
          sandboxId,
          stopCause: RECOVERY_SETTLED_REAP_REASON,
        }),
        sandboxId
      )
    ).toBe(false);
  });
});

describe('classifyFault recovery-outcome chain', () => {
  it('reports none when the window has no identity-matched failure evidence', () => {
    expect(classifyFault([], TARGET).kind).toBe('none');
    // Heartbeats are not failure evidence.
    expect(
      classifyFault(
        [heartbeat(TARGET.sandboxId, TARGET.connectionId, TARGET.wrapperInstanceId)],
        TARGET
      ).kind
    ).toBe('none');
  });

  it('does not classify an unrelated expiry as this session fault', () => {
    // The unrelated session shares one identity field (connectionId) with the
    // target but is a different sandbox and wrapper instance. A matcher that
    // accepts any single shared field would wrongly attribute this expiry. For
    // the target itself there is no failure evidence, so the result is `none`
    // rather than an ambiguous `inconclusive`.
    const records = [
      heartbeat(TARGET.sandboxId, TARGET.connectionId, TARGET.wrapperInstanceId),
      deadline('ses_other', TARGET.connectionId, 'wrapper_other'),
      recovery('ses_other', TARGET.connectionId, 'wrapper_other', 'heartbeat_expired', 'started'),
    ];
    const fault = classifyFault(records, TARGET);
    expect(fault.kind).not.toBe('heartbeat_expiry');
    expect(fault.kind).toBe('none');
  });

  it('reports inconclusive when matched failure evidence has no committed outcome', () => {
    // A matched heartbeatExpiry deadline with no started recovery is failure
    // evidence whose chain is incomplete: it must not collapse to `none`
    // (clean load) nor to a classified fault.
    const records = [deadline(TARGET.sandboxId, TARGET.connectionId, TARGET.wrapperInstanceId)];
    expect(classifyFault(records, TARGET).kind).toBe('inconclusive');
  });

  it('classifies a matched heartbeatExpiry deadline followed by a started heartbeat recovery', () => {
    const records = [
      deadline(TARGET.sandboxId, TARGET.connectionId, TARGET.wrapperInstanceId),
      recovery(
        TARGET.sandboxId,
        TARGET.connectionId,
        TARGET.wrapperInstanceId,
        'heartbeat_expired',
        'started'
      ),
    ];
    expect(classifyFault(records, TARGET).kind).toBe('heartbeat_expiry');
  });

  it('classifies skipped heartbeat then started disconnect as disconnect', () => {
    const records = [
      deadline(TARGET.sandboxId, TARGET.connectionId, TARGET.wrapperInstanceId),
      recovery(
        TARGET.sandboxId,
        TARGET.connectionId,
        TARGET.wrapperInstanceId,
        'heartbeat_expired',
        'skipped'
      ),
      recovery(
        TARGET.sandboxId,
        TARGET.connectionId,
        TARGET.wrapperInstanceId,
        'control_disconnected',
        'started'
      ),
    ];
    expect(classifyFault(records, TARGET).kind).toBe('disconnect');
  });

  it('is inconclusive when a heartbeat recovery starts without a preceding matched deadline', () => {
    const records = [
      recovery(
        TARGET.sandboxId,
        TARGET.connectionId,
        TARGET.wrapperInstanceId,
        'heartbeat_expired',
        'started'
      ),
    ];
    expect(classifyFault(records, TARGET).kind).toBe('inconclusive');
  });

  it('is inconclusive when only a skipped outcome exists', () => {
    const records = [
      deadline(TARGET.sandboxId, TARGET.connectionId, TARGET.wrapperInstanceId),
      recovery(
        TARGET.sandboxId,
        TARGET.connectionId,
        TARGET.wrapperInstanceId,
        'heartbeat_expired',
        'skipped'
      ),
    ];
    expect(classifyFault(records, TARGET).kind).toBe('inconclusive');
  });
});
