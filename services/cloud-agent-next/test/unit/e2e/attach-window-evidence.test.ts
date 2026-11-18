import { describe, expect, it } from 'vitest';

import { evaluateAttachWindow } from '../../e2e/attach-window-evidence.js';
import type { LogRecord } from '../../e2e/idle-stop-evidence.js';

const REQUEST_ID = 'req_attach';
const ATTACH_CONNECTION = 'conn_attach';

function attachRequest(): LogRecord {
  return {
    diagnosticEvent: 'socket_request_sent',
    operation: 'session.attach',
    requestId: REQUEST_ID,
    connectionId: ATTACH_CONNECTION,
  };
}

function responseFor(requestId: string): LogRecord {
  return { diagnosticEvent: 'socket_response', requestId, connectionId: ATTACH_CONNECTION };
}

function close(): LogRecord {
  return {
    diagnosticEvent: 'socket_closed',
    connectionId: ATTACH_CONNECTION,
    handshakeComplete: true,
  };
}

function reconnect(): LogRecord[] {
  return [
    {
      diagnosticEvent: 'handshake_committed',
      connectionId: 'conn_new',
      wrapperInstanceId: 'wrapper_1',
    },
    {
      diagnosticEvent: 'wrapper_ready',
      connectionId: 'conn_new',
      wrapperInstanceId: 'wrapper_1',
    },
  ];
}

function decide(records: LogRecord[], signalCursorPosition = 0) {
  return evaluateAttachWindow({
    records,
    requestId: REQUEST_ID,
    attachConnectionId: ATTACH_CONNECTION,
    signalCursorPosition,
  });
}

describe('evaluateAttachWindow', () => {
  it('is a miss when the attach response precedes the selected close', () => {
    const records = [attachRequest(), responseFor(REQUEST_ID), close(), ...reconnect()];
    expect(decide(records)).toEqual({ kind: 'missed' });
  });

  it('is a late response, not a miss, when the attach response follows the close', () => {
    const records = [attachRequest(), close(), responseFor(REQUEST_ID), ...reconnect()];
    expect(decide(records)).toEqual({ kind: 'late_response' });
  });

  it('recovers when no attach response appears around the selected close', () => {
    const records = [attachRequest(), close(), ...reconnect()];
    expect(decide(records)).toEqual({ kind: 'recovered' });
  });

  it('ignores a response for a different request id', () => {
    const records = [attachRequest(), responseFor('req_other'), close(), ...reconnect()];
    expect(decide(records)).toEqual({ kind: 'recovered' });
  });

  it('selects the first close at or after the signal cursor, ignoring an earlier close', () => {
    const preSignal = [attachRequest(), close()];
    const records = [
      ...preSignal,
      {
        diagnosticEvent: 'socket_closed',
        connectionId: ATTACH_CONNECTION,
        handshakeComplete: true,
      },
      ...reconnect(),
    ];
    expect(decide(records, preSignal.length)).toEqual({ kind: 'recovered' });
  });

  it('throws when no close matches after the signal cursor', () => {
    expect(() => decide([attachRequest()])).toThrow('attach window has no selected socket close');
  });
});
