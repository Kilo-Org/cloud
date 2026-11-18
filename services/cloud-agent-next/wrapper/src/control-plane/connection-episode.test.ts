import { describe, expect, it } from 'bun:test';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../../../src/shared/control-plane-protocol.js';
import type { ControlDiagnosticFields } from '../../../src/shared/control-diagnostics.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import { createControlPlaneConnection } from './connection.js';

type Recorded = { event: string; fields: ControlDiagnosticFields };

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(
    readonly url: string,
    readonly options?: unknown
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  fireError(): void {
    this.onerror?.();
  }

  fireClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  fireMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function timers() {
  return {
    ...CONTROL_PLANE_TIMERS,
    wrapper: {
      ...CONTROL_PLANE_TIMERS.wrapper,
      reconnectBackoffMinMs: 60_000,
      reconnectBackoffMaxMs: 60_000,
      heartbeatIntervalMs: 60_000,
    },
  };
}

describe('control-plane socket episode projection', () => {
  it('writes one line per disconnected episode and a new line after welcome', () => {
    const real = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const records: Recorded[] = [];
    const connection = createControlPlaneConnection({
      url: 'ws://fake',
      credential: 'credential',
      allocationId: 'alloc-1',
      wrapperId: 'wrapper-1',
      timers: timers(),
      random: () => 0,
      log: () => undefined,
      onNativeDiagnostic: (event, fields) => records.push({ event, fields }),
    });
    try {
      connection.start();
      const first = FakeWebSocket.instances[0];
      expect(first).toBeDefined();
      // error then close before open is one episode, one line.
      first?.fireError();
      first?.fireClose();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: 'control.socket',
        fields: {
          phase: 'connect_attempt',
          ok: false,
          allocationId: 'alloc-1',
          wrapperInstanceId: 'wrapper-1',
        },
      });

      // Reconnect and fail again before welcome: still the same episode.
      connection.recycle();
      const second = FakeWebSocket.instances[1];
      second?.fireOpen();
      second?.fireError();
      second?.fireClose();
      expect(records).toHaveLength(1);

      // A welcome clears the latch; the next close is a new episode.
      connection.recycle();
      const third = FakeWebSocket.instances[2];
      third?.fireOpen();
      third?.fireMessage({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
      third?.fireClose();
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        event: 'control.socket',
        fields: { phase: 'closed', allocationId: 'alloc-1', wrapperInstanceId: 'wrapper-1' },
      });
      expect(records[1]?.fields.phase).not.toBe('connect_attempt');
    } finally {
      connection.close();
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = real;
    }
  });

  it('does not report a deliberate recycle as a failure', () => {
    const real = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const records: Recorded[] = [];
    const connection = createControlPlaneConnection({
      url: 'ws://fake',
      credential: 'credential',
      allocationId: 'alloc-3',
      wrapperId: 'wrapper-3',
      timers: timers(),
      random: () => 0,
      log: () => undefined,
      onNativeDiagnostic: (event, fields) => records.push({ event, fields }),
    });
    try {
      connection.start();
      const socket = FakeWebSocket.instances[0];
      socket?.fireOpen();
      socket?.fireMessage({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });

      connection.recycle();
      socket?.fireClose();

      expect(records).toHaveLength(0);
    } finally {
      connection.close();
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = real;
    }
  });

  it('reports a hello rejection as its own line', () => {
    const real = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const records: Recorded[] = [];
    const connection = createControlPlaneConnection({
      url: 'ws://fake',
      credential: 'credential',
      allocationId: 'alloc-2',
      wrapperId: 'wrapper-2',
      timers: timers(),
      random: () => 0,
      log: () => undefined,
      onNativeDiagnostic: (event, fields) => records.push({ event, fields }),
    });
    try {
      connection.start();
      const socket = FakeWebSocket.instances[0];
      socket?.fireOpen();
      socket?.fireMessage({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
      socket?.fireMessage({ type: 'shutdown', reason: 'hello_rejected' });
      expect(records.map(record => record.fields.phase)).toEqual(['hello_rejected']);
    } finally {
      connection.close();
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = real;
    }
  });
});
