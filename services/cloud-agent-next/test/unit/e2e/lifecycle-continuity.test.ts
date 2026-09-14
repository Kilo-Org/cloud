import { describe, expect, it } from 'vitest';

import {
  classifyFault,
  matchesConnection,
  type ConnectionIdentity,
} from '../../e2e/lifecycle-continuity.js';
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
