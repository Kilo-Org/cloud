import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachWindowMissedError } from '../../e2e/attach-window-evidence.js';
import {
  acceptAttachWindow,
  createLocalScenarioEnvironment,
} from '../../e2e/capabilities-local.js';
import type { AttachWindowResult } from '../../e2e/attach-window-evidence.js';
import type { LogRecord } from '../../e2e/idle-stop-evidence.js';

const mocks = vi.hoisted(() => ({
  readWorkerLogSnapshot: vi.fn(),
  captureLogCursor: vi.fn(),
  captureControlWrapperProcess: vi.fn(),
  recycleControlConnection: vi.fn(),
  currentOwnedSandbox: vi.fn(),
}));

// The capability's Docker and worker-log boundaries are faked so the real
// `dropControlSocketDuringAttach` path runs without Docker or the log file.
vi.mock('../../e2e/idle-stop-evidence.js', () => ({
  readWorkerLogSnapshot: mocks.readWorkerLogSnapshot,
  captureLogCursor: mocks.captureLogCursor,
}));

vi.mock('../../e2e/sandbox-control.js', () => ({
  captureControlWrapperProcess: mocks.captureControlWrapperProcess,
  recycleControlConnection: mocks.recycleControlConnection,
  signalKiloServerProcess: vi.fn(),
  waitForNewSandboxPresent: vi.fn(),
}));

vi.mock('../../e2e/lifecycle.js', () => ({
  currentOwnedSandbox: mocks.currentOwnedSandbox,
  snapshotSandboxIds: vi.fn(),
  stopOwnedSandboxFamily: vi.fn(),
  waitForOwnedSandbox: vi.fn(),
}));

const REQUEST_ID = 'req_attach';
const ATTACH_CONNECTION = 'conn_attach';

const accepted: AttachWindowResult = {
  attachRequestId: REQUEST_ID,
  attachConnectionId: ATTACH_CONNECTION,
  closedConnectionId: ATTACH_CONNECTION,
  readyConnectionId: 'conn_new',
  wrapperInstanceId: 'wrapper_1',
  signaledPid: 4242,
};

function attachRequest(): LogRecord {
  return {
    diagnosticEvent: 'socket_request_sent',
    operation: 'session.attach',
    requestId: REQUEST_ID,
    connectionId: ATTACH_CONNECTION,
  };
}

function response(): LogRecord {
  return { diagnosticEvent: 'socket_response', requestId: REQUEST_ID, connectionId: ATTACH_CONNECTION };
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
    { diagnosticEvent: 'handshake_committed', connectionId: 'conn_new', wrapperInstanceId: 'wrapper_1' },
    { diagnosticEvent: 'wrapper_ready', connectionId: 'conn_new', wrapperInstanceId: 'wrapper_1' },
  ];
}

function accept(records: LogRecord[]): AttachWindowResult {
  return acceptAttachWindow({
    records,
    requestId: REQUEST_ID,
    attachConnectionId: ATTACH_CONNECTION,
    signalCursorPosition: 0,
    result: accepted,
  });
}

describe('acceptAttachWindow (the capability success return)', () => {
  it('throws attach window missed and does not return the ready connection when a response precedes the close', () => {
    const records = [attachRequest(), response(), close(), ...reconnect()];
    expect(() => accept(records)).toThrow('attach window missed');
  });

  it('throws attach response after close, not attach window missed, when a response follows the close', () => {
    const records = [attachRequest(), close(), response(), ...reconnect()];
    let caught: unknown;
    try {
      accept(records);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('attach response after close');
    expect(caught).not.toBeInstanceOf(AttachWindowMissedError);
  });

  it('returns the ready connection when no response appears around the close', () => {
    const records = [attachRequest(), close(), ...reconnect()];
    expect(accept(records)).toEqual(accepted);
  });
});

const WRAPPER_IDENTITY = 'container_1:4242';

function attachSentRecord(): LogRecord {
  return {
    diagnosticEvent: 'socket_request_sent',
    operation: 'session.attach',
    sessionId: 'workspace_test',
    requestId: REQUEST_ID,
    connectionId: ATTACH_CONNECTION,
    wrapperInstanceId: WRAPPER_IDENTITY,
  };
}

function responseRecord(): LogRecord {
  return {
    diagnosticEvent: 'socket_response',
    requestId: REQUEST_ID,
    connectionId: ATTACH_CONNECTION,
    wrapperInstanceId: WRAPPER_IDENTITY,
  };
}

function closeRecord(): LogRecord {
  return {
    diagnosticEvent: 'socket_closed',
    connectionId: ATTACH_CONNECTION,
    handshakeComplete: true,
    wrapperInstanceId: WRAPPER_IDENTITY,
  };
}

function reconnectRecords(): LogRecord[] {
  return [
    {
      diagnosticEvent: 'handshake_committed',
      connectionId: 'conn_new',
      wrapperInstanceId: WRAPPER_IDENTITY,
    },
    {
      diagnosticEvent: 'wrapper_ready',
      connectionId: 'conn_new',
      wrapperInstanceId: WRAPPER_IDENTITY,
    },
  ];
}

describe('dropControlSocketDuringAttach (capability invocation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureControlWrapperProcess.mockResolvedValue({
      containerId: 'container_1',
      processId: 4242,
    });
    mocks.recycleControlConnection.mockResolvedValue(undefined);
    mocks.captureLogCursor.mockResolvedValue({ fromByte: 0, capturedAt: Date.now() });
    mocks.currentOwnedSandbox.mockResolvedValue({ id: 'container_1' });
  });

  it('rejects a window miss when the attach response lands after the pre-signal snapshot but before the close', async () => {
    const attach = attachSentRecord();
    const fullStream = [attach, responseRecord(), closeRecord(), ...reconnectRecords()];
    let reads = 0;
    mocks.readWorkerLogSnapshot.mockImplementation(async () => {
      reads += 1;
      // Call 1 discovers the attach; call 2 is the pre-signal snapshot (the
      // response is not in it); later calls are the poll that returns the full
      // ordered stream.
      return reads <= 2 ? [attach] : fullStream;
    });

    const faults = createLocalScenarioEnvironment().sandboxFaults;
    if (!faults) throw new Error('sandboxFaults capability is required');

    await expect(
      faults.dropControlSocketDuringAttach({
        fromByte: 0,
        sessionId: 'workspace_test',
        kiloSessionId: 'ses_test',
        containerId: 'container_1',
        expectedWrapperInstanceId: WRAPPER_IDENTITY,
        waitForAttachMs: 1000,
      })
    ).rejects.toThrow('attach window missed');
    expect(mocks.recycleControlConnection).toHaveBeenCalledTimes(1);
  });
});
