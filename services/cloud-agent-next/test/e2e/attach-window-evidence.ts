/**
 * Ordered attach-window oracle for `control-socket-recycle-boot`.
 *
 * The `SIGUSR1` induction cannot be made a deterministic in-handler gate on this
 * harness, so the oracle decides, from one ordered worker-log stream, whether the
 * `session.attach` waiter was answered before the socket close the signal caused.
 *
 * A `socket_response` for the attach `requestId` before the selected close is a
 * positively established miss and the only retryable outcome. A matching
 * response after that close is not a miss: `socket_response` is logged before
 * `waiters.settle`, and `settle` returns false when the waiter is already gone,
 * so it does not prove the close won. No response on either side is `recovered`,
 * which the capability only accepts once the reconnect sequence itself is
 * present. This does not establish that the waiter was still pending: a timeout
 * deletes the waiter and rejects with no `socket_response`.
 *
 * Pure: it reads a supplied record stream and never touches Docker or the log.
 */

import type { LogRecord } from './idle-stop-evidence.js';

export type AttachWindowDecision =
  | { kind: 'recovered' }
  | { kind: 'missed' }
  | { kind: 'late_response' };

/** The capability's success payload once the attach window is accepted. */
export type AttachWindowResult = {
  attachRequestId: string;
  attachConnectionId: string;
  closedConnectionId: string;
  readyConnectionId: string;
  wrapperInstanceId: string;
  signaledPid: number;
};

/**
 * Thrown only for a positively established miss: a `socket_response` for the
 * attach `requestId` before the selected `socket_closed`. It is the only
 * outcome the scenario retries.
 */
export class AttachWindowMissedError extends Error {
  constructor() {
    super('attach window missed');
    this.name = 'AttachWindowMissedError';
  }
}

/**
 * One ordered pass over `records`, which spans the original attach cursor
 * through the latest read. `signalCursorPosition` is the record position
 * captured immediately before the signal: the selected `socket_closed` is the
 * first matching close at or after it, so a natural close before the signal is
 * never credited. `records` has no per-record byte offsets, so the boundary is
 * the record count observed at signal time, not a log byte.
 */
export function evaluateAttachWindow(input: {
  records: LogRecord[];
  requestId: string;
  attachConnectionId: string;
  signalCursorPosition: number;
}): AttachWindowDecision {
  const { records, requestId, attachConnectionId, signalCursorPosition } = input;
  let closeIndex = -1;
  for (let index = Math.max(0, signalCursorPosition); index < records.length; index += 1) {
    const record = records[index];
    if (
      record.diagnosticEvent === 'socket_closed' &&
      record.connectionId === attachConnectionId &&
      record.handshakeComplete === true
    ) {
      closeIndex = index;
      break;
    }
  }
  if (closeIndex < 0) {
    throw new Error('attach window has no selected socket close');
  }

  let firstResponseIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.diagnosticEvent === 'socket_response' && record.requestId === requestId) {
      firstResponseIndex = index;
      break;
    }
  }
  if (firstResponseIndex < 0) return { kind: 'recovered' };
  return firstResponseIndex < closeIndex ? { kind: 'missed' } : { kind: 'late_response' };
}
