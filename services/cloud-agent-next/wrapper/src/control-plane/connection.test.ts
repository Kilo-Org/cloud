import {
  WORKTREE_RUNTIME_HEADER,
  WORKTREE_RUNTIME_VERSION,
} from '../../../src/shared/control-plane-runtime-contract.js';
import { describe, expect, it } from 'bun:test';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlaneHelloFrame,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  CONTROL_PLANE_TIMERS,
  resolveControlPlaneTimers,
  type ControlPlaneTimers,
} from '../../../src/shared/control-plane-timers.js';
import {
  controlPlaneReconnectDelayMs,
  createControlPlaneConnection,
  type ControlPlaneConnection,
  type ControlPlaneConnectionOptions,
} from './connection.js';

type WrapperTimerOverrides = Partial<ControlPlaneTimers['wrapper']>;

class TestSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: TestSocket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  frames: ControlPlaneWrapperFrame[] = [];
  sendCalls = 0;
  failSendAt?: number;
  closes = 0;
  constructor(
    _url: string,
    readonly options?: { headers?: Record<string, string> }
  ) {
    TestSocket.instances.push(this);
  }
  send(text: string): void {
    this.sendCalls += 1;
    if (this.sendCalls === this.failSendAt) throw new Error('test send failure');
    this.frames.push(JSON.parse(text));
  }
  close(): void {
    this.closes += 1;
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

type TestTimeout = { run(): void; ms: number; cleared: boolean };

function withControlledConnection(
  run: (test: {
    connection: ControlPlaneConnection;
    timeouts: TestTimeout[];
    connected: () => number;
    disconnected: string[];
    shutdowns: Array<string | undefined>;
    logs: string[];
  }) => void,
  overrides: Partial<ControlPlaneConnectionOptions> = {}
): void {
  const original = {
    WebSocket: globalThis.WebSocket,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const timeouts: TestTimeout[] = [];
  Object.assign(globalThis, {
    WebSocket: TestSocket,
    setTimeout: (run: () => void, ms: number) => {
      const timeout = { run, ms, cleared: false };
      timeouts.push(timeout);
      return timeout;
    },
    clearTimeout: (timeout: TestTimeout | undefined) => {
      if (timeout) timeout.cleared = true;
    },
  });
  TestSocket.instances = [];
  let connected = 0;
  const disconnected: string[] = [];
  const shutdowns: Array<string | undefined> = [];
  const logs: string[] = [];
  const connection = createControlPlaneConnection({
    url: 'ws://test',
    credential: 'test',
    allocationId: 'alloc-1',
    timers: timerOverrides({ reconnectBackoffMinMs: 10, reconnectBackoffMaxMs: 20 }),
    random: () => 0,
    onConnected: () => (connected += 1),
    onDisconnected: reason => disconnected.push(reason),
    onShutdown: reason => shutdowns.push(reason),
    log: message => logs.push(message),
    ...overrides,
  });
  try {
    connection.start();
    run({ connection, timeouts, connected: () => connected, disconnected, shutdowns, logs });
  } finally {
    connection.close();
    Object.assign(globalThis, original);
  }
}

async function withTestSocket(
  run: (
    connection: ControlPlaneConnection,
    socket: TestSocket,
    disconnected: string[]
  ) => Promise<void>
): Promise<void> {
  const original = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: TestSocket });
  TestSocket.instances = [];
  const disconnected: string[] = [];
  const connection = createControlPlaneConnection({
    url: 'ws://test',
    credential: 'test',
    allocationId: 'alloc-1',
    timers: timerOverrides({
      heartbeatIntervalMs: 10,
      heartbeatAckTimeoutMs: 80,
      heartbeatNegotiationMs: 10,
      reconnectBackoffMinMs: 10,
      reconnectBackoffMaxMs: 20,
    }),
    random: () => 0,
    onDisconnected: reason => disconnected.push(reason),
  });
  try {
    connection.start();
    const socket = TestSocket.instances[0];
    socket.onopen?.();
    await run(connection, socket, disconnected);
  } finally {
    connection.close();
    Object.assign(globalThis, { WebSocket: original });
  }
}

it('advertises worktree support without changing the strict legacy hello', () => {
  withControlledConnection(({ connection }) => {
    connection.start();
    const socket = TestSocket.instances[0];
    expect(socket.options?.headers?.[WORKTREE_RUNTIME_HEADER]).toBe(WORKTREE_RUNTIME_VERSION);
    socket.onopen?.();
    expect(socket.frames[0]).toEqual({
      type: 'hello',
      wrapperId: connection.wrapperId,
      allocationId: 'alloc-1',
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      heartbeatAck: true,
      redactsNamedSecrets: true,
    });
  });
});

describe('acknowledged heartbeat', () => {
  it.each(['connected', 'awaiting_welcome', 'connecting'] as const)(
    'recycles %s immediately without waiting for close or retaining old timers',
    async phase => {
      await withTestSocket(async (connection, socket, disconnected) => {
        if (phase === 'connected')
          socket.receive({
            type: 'welcome',
            protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
            heartbeatAck: true,
          });
        if (phase === 'connecting') {
          connection.recycle();
          socket = TestSocket.instances[1];
          socket.readyState = TestSocket.CONNECTING;
        }
        const sent = socket.frames.length;
        const count = TestSocket.instances.length;
        connection.recycle();
        expect(TestSocket.instances).toHaveLength(count + 1);
        expect(socket.closes).toBe(1);
        socket.onopen?.();
        socket.receive({
          type: 'welcome',
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          heartbeatAck: true,
        });
        socket.receive({ type: 'shutdown', reason: 'stale' });
        socket.onclose?.();
        await Bun.sleep(120);
        expect(socket.frames).toHaveLength(sent);
        expect(TestSocket.instances).toHaveLength(count + 1);
        expect(disconnected).toEqual(phase === 'connected' ? ['connection recycled'] : []);
      });
    }
  );

  it('uses the production 5s heartbeat and 15s acknowledgement deadline', () => {
    expect(CONTROL_PLANE_TIMERS.wrapper.heartbeatIntervalMs).toBe(5_000);
    expect(CONTROL_PLANE_TIMERS.wrapper.heartbeatAckTimeoutMs).toBe(15_000);
    expect(CONTROL_PLANE_TIMERS.wrapper.heartbeatNegotiationMs).toBe(1_000);
    expect(CONTROL_PLANE_TIMERS.sandbox.heartbeatMs).toBe(45_000);
    expect(CONTROL_PLANE_TIMERS.sandbox.reconnectMs).toBe(90_000);
    expect(CONTROL_PLANE_TIMERS.wrapper.reconnectBackoffMinMs).toBe(1_000);
    expect(CONTROL_PLANE_TIMERS.wrapper.reconnectBackoffMaxMs).toBe(30_000);
    const scaled = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '100' });
    expect(scaled.wrapper.heartbeatIntervalMs).toBe(50);
    expect(scaled.wrapper.heartbeatAckTimeoutMs).toBe(150);
    expect(scaled.sandbox.heartbeatMs).toBe(450);
    expect(scaled.sandbox.reconnectMs).toBe(900);
  });
  it('uses a legacy hello fallback and never times out an unnegotiated peer', async () => {
    await withTestSocket(async (_connection, socket, disconnected) => {
      expect(socket.frames[0]).toMatchObject({ type: 'hello', heartbeatAck: true });
      await waitFor(() => socket.frames.length === 2);
      expect(socket.frames[1]).toEqual({
        type: 'hello',
        wrapperId: socket.frames[0].type === 'hello' ? socket.frames[0].wrapperId : '',
        allocationId: 'alloc-1',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      });
      socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
      await Bun.sleep(120);
      expect(disconnected).toEqual([]);
      expect(TestSocket.instances).toHaveLength(1);
    });
  });

  it('starts at welcome, resets only on ack and reconnects without a close callback', async () => {
    await withTestSocket(async (_connection, socket, disconnected) => {
      await Bun.sleep(100);
      expect(disconnected).toEqual([]);
      socket.receive({
        type: 'welcome',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        heartbeatAck: true,
      });
      await Bun.sleep(45);
      socket.receive({ type: 'heartbeat_ack' });
      await Bun.sleep(45);
      expect(disconnected).toEqual([]);
      socket.receive({ type: 'events_dropped', dropped: 1 });
      await waitFor(() => TestSocket.instances.length === 2);
      expect(disconnected).toEqual(['heartbeat acknowledgement timeout']);
      expect(socket.closes).toBe(1);
      const replacement = TestSocket.instances[1];
      replacement.onopen?.();
      replacement.receive({
        type: 'welcome',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        heartbeatAck: true,
      });
      socket.receive({ type: 'shutdown', reason: 'stale' });
      socket.receive({ type: 'heartbeat_ack' });
      socket.onclose?.();
      await waitFor(() => TestSocket.instances.length === 3);
      expect(disconnected).toHaveLength(2);
    });
  });

  it('shutdown is terminal with a watchdog and pending negotiation', async () => {
    await withTestSocket(async (connection, socket, disconnected) => {
      socket.receive({
        type: 'welcome',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        heartbeatAck: true,
      });
      socket.receive({ type: 'shutdown', reason: 'stopped' });
      socket.receive({ type: 'heartbeat_ack' });
      socket.onclose?.();
      connection.start();
      await Bun.sleep(120);
      expect(TestSocket.instances).toHaveLength(1);
      expect(disconnected).toEqual([]);
    });
  });
});

describe('control-plane handshake recovery', () => {
  it.each(['connecting', 'awaiting_welcome'] as const)(
    'bounds a hung %s attempt and fences late callbacks without shutdown',
    phase => {
      withControlledConnection(({ connection, timeouts, connected, disconnected, shutdowns }) => {
        const socket = TestSocket.instances[0];
        socket.readyState = TestSocket.CONNECTING;
        const deadline = timeouts[0];
        expect(deadline.ms).toBe(CONTROL_PLANE_TIMERS.wrapper.handshakeMs);
        expect(deadline.ms).toBe(30_000);
        if (phase === 'awaiting_welcome') {
          socket.readyState = TestSocket.OPEN;
          socket.onopen?.();
          socket.receive({ type: 'welcome', protocolVersion: -1 });
        }
        expect(connection.snapshot().phase).toBe(phase);
        expect(deadline.cleared).toBe(false);
        deadline.run();
        expect(deadline.cleared).toBe(true);
        expect(socket.closes).toBe(1);
        expect(connection.snapshot()).toMatchObject({ phase: 'idle', attempt: 1 });
        expect(connected()).toBe(0);
        expect(disconnected).toEqual([]);
        expect(shutdowns).toEqual([]);
        connection.start();
        expect(TestSocket.instances).toHaveLength(1);

        const retry = timeouts[timeouts.length - 1];
        expect(retry.ms).toBe(10);
        retry.run();
        const replacement = TestSocket.instances[1];
        socket.onopen?.();
        socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
        socket.receive({ type: 'shutdown', reason: 'stale' });
        socket.onerror?.();
        socket.onclose?.();
        deadline.run();
        expect(connection.snapshot().phase).toBe('connecting');
        replacement.onopen?.();
        replacement.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
        expect(connection.snapshot()).toMatchObject({ phase: 'connected', attempt: 0 });
        expect(connected()).toBe(1);
        expect(shutdowns).toEqual([]);
      });
    }
  );

  it.each(['welcome', 'socket close', 'socket error', 'recycle', 'shutdown', 'close'] as const)(
    'clears handshake and negotiation timers on %s, including already queued callbacks',
    end => {
      withControlledConnection(({ connection, timeouts, disconnected, shutdowns }) => {
        const socket = TestSocket.instances[0];
        socket.onopen?.();
        const [deadline, negotiation] = timeouts;
        if (end === 'welcome')
          socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
        if (end === 'socket close') socket.onclose?.();
        if (end === 'socket error') socket.onerror?.();
        if (end === 'recycle') connection.recycle();
        if (end === 'shutdown') socket.receive({ type: 'shutdown', reason: 'stopped' });
        if (end === 'close') connection.close();
        expect(deadline.cleared).toBe(true);
        expect(negotiation.cleared).toBe(true);
        const snapshot = connection.snapshot();
        const scheduled = timeouts.length;
        deadline.run();
        negotiation.run();
        expect(connection.snapshot()).toEqual(snapshot);
        expect(timeouts).toHaveLength(scheduled);
        expect(socket.frames).toHaveLength(1);
        expect(disconnected).toEqual([]);
        expect(shutdowns).toEqual(end === 'shutdown' ? ['stopped'] : []);
      });
    }
  );

  it('backs off across repeated hung handshakes', () => {
    withControlledConnection(({ connection, timeouts, shutdowns }) => {
      for (const delay of [10, 20, 20]) {
        const deadline = timeouts[timeouts.length - 1];
        deadline.run();
        const retry = timeouts[timeouts.length - 1];
        expect(retry.ms).toBe(delay);
        retry.run();
      }
      expect(TestSocket.instances).toHaveLength(4);
      expect(connection.snapshot()).toMatchObject({ phase: 'connecting', attempt: 3 });
      expect(shutdowns).toEqual([]);
    });
  });

  it.each(['hello', 'fallback'] as const)('reconnects after a throwing %s write', failure => {
    withControlledConnection(({ connection, timeouts, connected, shutdowns }) => {
      const socket = TestSocket.instances[0];
      if (failure === 'hello') socket.failSendAt = 1;
      socket.onopen?.();
      if (failure === 'fallback') {
        socket.failSendAt = 2;
        timeouts[1].run();
      }
      expect(connection.snapshot()).toMatchObject({ phase: 'idle', attempt: 1 });
      expect(timeouts[0].cleared).toBe(true);
      expect(socket.closes).toBe(1);
      expect(connected()).toBe(0);
      expect(shutdowns).toEqual([]);
      expect(timeouts[timeouts.length - 1].ms).toBe(10);
    });
  });
});

describe('control-plane failed writes', () => {
  const events: ControlPlaneWrapperFrame[] = [
    {
      type: 'session.events',
      sessionId: 'session-1',
      events: [{ type: 'event.1', properties: { text: '\u00e9' } }],
    },
    {
      type: 'session.events',
      sessionId: 'session-1',
      events: [{ type: 'event.2', properties: {} }],
    },
    {
      type: 'session.events',
      sessionId: 'session-1',
      events: [{ type: 'event.3', properties: {} }],
    },
  ];
  const outcome: ControlPlaneWrapperFrame = {
    type: 'session.outcome',
    sessionId: 'session-1',
    status: 'completed',
    lastMessageId: 'message-1',
  };
  const bytesOf = (frames: ControlPlaneWrapperFrame[]): number =>
    frames.reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame)), 0);

  it.each([0, 1])('retains the unsent suffix when flush write %s throws', failedIndex => {
    withControlledConnection(({ connection, timeouts, connected, disconnected, shutdowns }) => {
      const pending = [events[0], events[1], outcome];
      for (const frame of pending) connection.send(frame);
      expect(connection.snapshot().outboxBytes).toBe(bytesOf(pending));
      const socket = TestSocket.instances[0];
      socket.onopen?.();
      socket.failSendAt = socket.sendCalls + failedIndex + 1;
      socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
      const suffix = pending.slice(failedIndex);
      expect(socket.frames.slice(1)).toEqual(pending.slice(0, failedIndex));
      expect(connection.snapshot()).toMatchObject({
        phase: 'idle',
        attempt: 1,
        outboxBytes: bytesOf(suffix),
      });
      expect(socket.closes).toBe(1);
      expect(connected()).toBe(0);
      expect(disconnected).toEqual([]);
      expect(shutdowns).toEqual([]);

      timeouts[timeouts.length - 1].run();
      const replacement = TestSocket.instances[1];
      replacement.onopen?.();
      replacement.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
      expect(replacement.frames.slice(1)).toEqual(suffix);
      expect(connection.snapshot()).toMatchObject({ phase: 'connected', outboxBytes: 0 });
      expect(connected()).toBe(1);
    });
  });

  it.each(['marker', 'frame'] as const)(
    'retains a failed drop marker but never replays a successfully written marker after %s failure',
    failure => {
      withControlledConnection(
        ({ connection, timeouts, connected, disconnected }) => {
          for (const frame of [...events, outcome]) connection.send(frame);
          const retained = [events[2], outcome];
          const marker = { type: 'events_dropped', dropped: 2 } satisfies ControlPlaneWrapperFrame;
          const socket = TestSocket.instances[0];
          socket.onopen?.();
          socket.failSendAt = socket.sendCalls + (failure === 'marker' ? 1 : 2);
          socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
          expect(socket.frames.slice(1)).toEqual(failure === 'marker' ? [] : [marker]);
          expect(connection.snapshot()).toMatchObject({
            phase: 'idle',
            outboxBytes: bytesOf(retained),
          });
          expect(socket.closes).toBe(1);
          expect(connected()).toBe(0);
          expect(disconnected).toEqual([]);
          timeouts[timeouts.length - 1].run();
          const replacement = TestSocket.instances[1];
          replacement.onopen?.();
          replacement.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
          expect(replacement.frames.slice(1)).toEqual([
            ...(failure === 'marker' ? [marker] : []),
            ...retained,
          ]);
          expect(connection.snapshot().outboxBytes).toBe(0);
          expect(connected()).toBe(1);
        },
        { outboxMaxFrames: 2 }
      );
    }
  );

  it.each(['throw', 'not open'] as const)(
    'retains a direct write and reconnects immediately when the socket is %s',
    failure => {
      withControlledConnection(({ connection, timeouts, connected, disconnected, shutdowns }) => {
        const socket = TestSocket.instances[0];
        socket.onopen?.();
        socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
        if (failure === 'throw') socket.failSendAt = socket.sendCalls + 1;
        else socket.readyState = TestSocket.CONNECTING;
        connection.send(outcome);
        expect(connection.snapshot()).toMatchObject({
          phase: 'idle',
          attempt: 1,
          outboxBytes: bytesOf([outcome]),
        });
        expect(disconnected).toEqual([failure === 'throw' ? 'send failed' : 'socket not open']);
        expect(socket.closes).toBe(1);
        socket.receive({ type: 'shutdown', reason: 'stale' });
        socket.onerror?.();
        socket.onclose?.();
        timeouts[timeouts.length - 1].run();
        const replacement = TestSocket.instances[1];
        replacement.onopen?.();
        replacement.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
        expect(replacement.frames.slice(1)).toEqual([outcome]);
        expect(connected()).toBe(2);
        expect(connection.snapshot().outboxBytes).toBe(0);
        expect(shutdowns).toEqual([]);
      });
    }
  );

  it.each(['frames', 'bytes'] as const)(
    'rejects newest under critical-only %s pressure without evicting retained outcomes',
    limit => {
      const retained = [outcome, { ...outcome, lastMessageId: 'message-2' }];
      withControlledConnection(
        ({ connection, logs }) => {
          for (const frame of retained) connection.send(frame);
          connection.send({ ...outcome, lastMessageId: 'message-3' });
          connection.send({ type: 'session.progress', sessionId: 'session-1', step: 'clone' });
          connection.send(events[0]);
          expect(connection.snapshot().outboxBytes).toBe(bytesOf(retained));
          expect(logs.filter(line => line.includes('newest'))).toHaveLength(3);
          const socket = TestSocket.instances[0];
          socket.onopen?.();
          socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
          expect(socket.frames.slice(1)).toEqual([
            { type: 'events_dropped', dropped: 1 },
            ...retained,
          ]);
          expect(connection.snapshot().outboxBytes).toBe(0);
        },
        limit === 'frames' ? { outboxMaxFrames: 2 } : { outboxMaxBytes: bytesOf(retained) }
      );
    }
  );

  const progress: Extract<ControlPlaneWrapperFrame, { type: 'session.progress' }> = {
    type: 'session.progress',
    sessionId: 'session-1',
    step: 'clone',
  };
  const ready: ControlPlaneWrapperFrame = { type: 'session.ready', sessionId: 'session-1' };

  it.each([
    ['outcome', outcome],
    ['ready', ready],
  ] as const)(
    'evicts display-only progress before rejecting a newer %s transition',
    (_name, critical) => {
      withControlledConnection(
        ({ connection, logs }) => {
          const queued: ControlPlaneWrapperFrame[] = [
            progress,
            { ...progress, step: 'setup' },
            events[0],
          ];
          for (const frame of queued) connection.send(frame);
          const later = { ...outcome, lastMessageId: 'message-2' };
          connection.send(critical);
          connection.send(later);
          expect(logs.filter(line => line.includes('rejected'))).toEqual([
            'control-plane outbox rejected the newest session.events frame at capacity',
          ]);
          const socket = TestSocket.instances[0];
          socket.onopen?.();
          socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
          expect(socket.frames.slice(1)).toEqual([
            { type: 'events_dropped', dropped: 1 },
            critical,
            later,
          ]);
        },
        { outboxMaxFrames: 2 }
      );
    }
  );

  it('never lets an event evict progress', () => {
    withControlledConnection(
      ({ connection }) => {
        connection.send(progress);
        connection.send(events[0]);
        expect(connection.snapshot().outboxBytes).toBe(bytesOf([progress]));
        const socket = TestSocket.instances[0];
        socket.onopen?.();
        socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
        expect(socket.frames.slice(1)).toEqual([{ type: 'events_dropped', dropped: 1 }, progress]);
      },
      { outboxMaxFrames: 1 }
    );
  });

  it('does not evict events for a critical frame that cannot fit even after eviction', () => {
    withControlledConnection(
      ({ connection, logs }) => {
        connection.send(outcome);
        connection.send(events[1]);
        const before = connection.snapshot().outboxBytes;
        connection.send({ ...outcome, lastMessageId: `message-${'x'.repeat(100)}` });
        expect(connection.snapshot().outboxBytes).toBe(before);
        expect(logs).toContain(
          'control-plane outbox rejected the newest session.outcome frame at capacity'
        );
        const socket = TestSocket.instances[0];
        socket.onopen?.();
        socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
        expect(socket.frames.slice(1)).toEqual([outcome, events[1]]);
      },
      { outboxMaxBytes: bytesOf([outcome, events[1]]) }
    );
  });

  it('treats a welcome on a socket that is no longer open as a failed connect attempt', () => {
    withControlledConnection(({ connection, timeouts, connected, disconnected }) => {
      connection.send(outcome);
      const socket = TestSocket.instances[0];
      socket.onopen?.();
      socket.readyState = 2;
      socket.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
      expect(socket.frames).toHaveLength(1);
      expect(connection.snapshot()).toMatchObject({
        phase: 'idle',
        attempt: 1,
        outboxBytes: bytesOf([outcome]),
      });
      expect(connected()).toBe(0);
      expect(disconnected).toEqual([]);
      timeouts[timeouts.length - 1].run();
      const replacement = TestSocket.instances[1];
      replacement.onopen?.();
      replacement.receive({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
      expect(replacement.frames.slice(1)).toEqual([outcome]);
      expect(connected()).toBe(1);
    });
  });
});

type HeartbeatFrame = Extract<ControlPlaneWrapperFrame, { type: 'heartbeat' }>;
type EventsFrame = Extract<ControlPlaneWrapperFrame, { type: 'session.events' }>;
type EventsDroppedFrame = Extract<ControlPlaneWrapperFrame, { type: 'events_dropped' }>;

function isFrame<T extends ControlPlaneWrapperFrame['type']>(
  frame: ControlPlaneWrapperFrame,
  type: T
): frame is Extract<ControlPlaneWrapperFrame, { type: T }> {
  return frame.type === type;
}

function timerOverrides(overrides: WrapperTimerOverrides): ControlPlaneTimers {
  return {
    ...CONTROL_PLANE_TIMERS,
    wrapper: { ...CONTROL_PLANE_TIMERS.wrapper, ...overrides },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await Bun.sleep(5);
  }
}

function decode(raw: string | Buffer | Uint8Array): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

type FakeSandbox = {
  url: string;
  frames: ControlPlaneWrapperFrame[];
  heartbeatAt: number[];
  helloFrames: ControlPlaneHelloFrame[];
  authorizations: string[];
  connectionCount(): number;
  attempts(): number;
  setMode(mode: 'accept' | 'reject'): void;
  send(frame: ControlPlaneWrapperFrame): void;
  stop(): void;
};

function createFakeSandbox(): FakeSandbox {
  const frames: ControlPlaneWrapperFrame[] = [];
  const heartbeatAt: number[] = [];
  const helloFrames: ControlPlaneHelloFrame[] = [];
  const authorizations: string[] = [];
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  let mode: 'accept' | 'reject' = 'accept';
  let attempts = 0;
  let connections = 0;

  const server = Bun.serve<undefined>({
    port: 0,
    fetch(request, srv) {
      attempts += 1;
      authorizations.push(request.headers.get('authorization') ?? '');
      if (mode === 'reject') return new Response('rejected', { status: 503 });
      if (srv.upgrade(request)) return undefined;
      return new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(socket) {
        connections += 1;
        sockets.add(socket);
        socket.send(
          JSON.stringify({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION })
        );
      },
      message(_socket, raw) {
        const frame = JSON.parse(decode(raw)) as ControlPlaneWrapperFrame;
        frames.push(frame);
        if (frame.type === 'heartbeat') heartbeatAt.push(Date.now());
        if (frame.type === 'hello') helloFrames.push(frame);
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/sandbox-control-v2/fake`,
    frames,
    heartbeatAt,
    helloFrames,
    authorizations,
    connectionCount: () => connections,
    attempts: () => attempts,
    setMode: next => {
      mode = next;
    },
    send: frame => {
      for (const socket of sockets) socket.send(JSON.stringify(frame));
    },
    stop: () => {
      void server.stop(true);
    },
  };
}

async function connect(
  sandbox: FakeSandbox,
  overrides: {
    timers?: ControlPlaneTimers;
    wrapperId?: string;
    heartbeat?: () => { active: boolean; degraded: boolean };
    onShutdown?: (reason: string | undefined) => void;
    onConnected?: () => void;
    onDisconnected?: (reason: string) => void;
    outboxMaxFrames?: number;
  } = {}
): Promise<ControlPlaneConnection> {
  const connection = createControlPlaneConnection({
    url: sandbox.url,
    credential: 'secret-credential',
    allocationId: 'alloc-1',
    wrapperId: overrides.wrapperId ?? 'wrapper-1',
    timers:
      overrides.timers ??
      timerOverrides({
        heartbeatIntervalMs: 10_000,
        reconnectBackoffMinMs: 5,
        reconnectBackoffMaxMs: 15,
      }),
    random: () => 0,
    log: () => undefined,
    ...(overrides.heartbeat ? { getHeartbeat: overrides.heartbeat } : {}),
    ...(overrides.onShutdown ? { onShutdown: overrides.onShutdown } : {}),
    ...(overrides.onConnected ? { onConnected: overrides.onConnected } : {}),
    ...(overrides.onDisconnected ? { onDisconnected: overrides.onDisconnected } : {}),
    ...(overrides.outboxMaxFrames ? { outboxMaxFrames: overrides.outboxMaxFrames } : {}),
  });
  connection.start();
  return connection;
}

describe('control-plane turn cap and accepted backstop', () => {
  it('derives the 125-minute accepted backstop from the 120-minute cap', () => {
    expect(CONTROL_PLANE_TIMERS.wrapper.turnHardCapMs).toBe(7_200_000);
    expect(CONTROL_PLANE_TIMERS.session.acceptedBackstopMs).toBe(7_500_000);

    const margin =
      CONTROL_PLANE_TIMERS.session.acceptedBackstopMs - CONTROL_PLANE_TIMERS.wrapper.turnHardCapMs;
    expect(margin).toBe(300_000);
    expect(CONTROL_PLANE_TIMERS.session.acceptedBackstopMs).toBeGreaterThan(
      CONTROL_PLANE_TIMERS.wrapper.turnHardCapMs
    );

    const scaled = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '100' });
    expect(scaled.wrapper.turnHardCapMs).toBe(72_000);
    // The accepted-backstop margin is not scaled, so it does not shrink with the cap.
    expect(scaled.session.acceptedBackstopMs).toBe(372_000);
    expect(scaled.session.acceptedBackstopMs).toBe(scaled.wrapper.turnHardCapMs + margin);
    expect(scaled.session.acceptedBackstopMs).toBeGreaterThan(scaled.wrapper.turnHardCapMs);
  });
});

describe('controlPlaneReconnectDelayMs', () => {
  it('grows from the minimum to the maximum and adds bounded jitter', () => {
    const timers = timerOverrides({ reconnectBackoffMinMs: 50, reconnectBackoffMaxMs: 800 });
    expect(controlPlaneReconnectDelayMs(timers, 1, () => 0)).toBe(50);
    expect(controlPlaneReconnectDelayMs(timers, 2, () => 0)).toBe(100);
    expect(controlPlaneReconnectDelayMs(timers, 5, () => 0)).toBe(800);
    expect(controlPlaneReconnectDelayMs(timers, 50, () => 0)).toBe(800);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const delay = controlPlaneReconnectDelayMs(timers, attempt, () => 0.999);
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(800 + Math.floor(50 / 4));
    }
  });
});

describe('createControlPlaneConnection', () => {
  it('connects forever with backoff and recovers when the peer returns', async () => {
    const sandbox = createFakeSandbox();
    sandbox.setMode('reject');
    let connected = 0;
    const connection = await connect(sandbox, { onConnected: () => (connected += 1) });
    try {
      await waitFor(() => sandbox.attempts() >= 3);
      expect(connected).toBe(0);
      sandbox.setMode('accept');
      await waitFor(() => connected === 1);
      expect(sandbox.connectionCount()).toBe(1);
    } finally {
      connection.close();
      sandbox.stop();
    }
  });

  it('snapshots the live phase, attempt and outbox bytes without a url or credential', async () => {
    const sandbox = createFakeSandbox();
    sandbox.setMode('reject');
    const connection = await connect(sandbox, {
      timers: timerOverrides({ reconnectBackoffMinMs: 5, reconnectBackoffMaxMs: 15 }),
    });
    try {
      connection.send({
        type: 'session.outcome',
        sessionId: 'session-1',
        status: 'completed',
        lastMessageId: 'message-1',
      });
      await waitFor(() => sandbox.attempts() >= 1);
      const snapshot = connection.snapshot();
      expect(snapshot.phase).not.toBe('connected');
      expect(snapshot.attempt).toBeGreaterThanOrEqual(1);
      expect(snapshot.outboxBytes).toBeGreaterThan(0);
      expect(snapshot).not.toHaveProperty('url');
      expect(snapshot).not.toHaveProperty('credential');
      expect(JSON.stringify(snapshot)).not.toContain('secret-credential');
    } finally {
      connection.close();
      sandbox.stop();
    }
  });

  it('sends hello, accepts welcome and handles shutdown', async () => {
    const sandbox = createFakeSandbox();
    const shutdowns: Array<string | undefined> = [];
    let connected = 0;
    const connection = await connect(sandbox, {
      onConnected: () => (connected += 1),
      onShutdown: reason => shutdowns.push(reason),
    });
    try {
      await waitFor(() => connected === 1);
      await waitFor(() => sandbox.helloFrames.length === 1);
      expect(sandbox.helloFrames[0]).toEqual({
        type: 'hello',
        wrapperId: 'wrapper-1',
        allocationId: 'alloc-1',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        heartbeatAck: true,
        redactsNamedSecrets: true,
      });
      expect(sandbox.authorizations[0]).toBe('Bearer secret-credential');

      sandbox.send({ type: 'shutdown', reason: 'hello_rejected' });
      await waitFor(() => shutdowns.length === 1);
      expect(shutdowns[0]).toBe('hello_rejected');
    } finally {
      connection.close();
      sandbox.stop();
    }
  });

  it('sends heartbeats at the configured cadence with active and degraded', async () => {
    const sandbox = createFakeSandbox();
    const connection = await connect(sandbox, {
      timers: timerOverrides({
        heartbeatIntervalMs: 25,
        reconnectBackoffMinMs: 5,
        reconnectBackoffMaxMs: 15,
      }),
      heartbeat: () => ({ active: true, degraded: true }),
    });
    try {
      await waitFor(() => sandbox.heartbeatAt.length >= 3, 3_000);
      const beats = sandbox.frames.filter((frame): frame is HeartbeatFrame =>
        isFrame(frame, 'heartbeat')
      );
      expect(beats.length).toBeGreaterThanOrEqual(3);
      for (const beat of beats) {
        expect(beat).toEqual({ type: 'heartbeat', active: true, degraded: true });
      }
      const gaps = sandbox.heartbeatAt
        .slice(1)
        .map((at, index) => at - (sandbox.heartbeatAt[index] ?? at));
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(12);
        expect(gap).toBeLessThanOrEqual(200);
      }
    } finally {
      connection.close();
      sandbox.stop();
    }
  });

  it('closes permanently on shutdown even when the callback does not exit the process', async () => {
    const sandbox = createFakeSandbox();
    const shutdowns: Array<string | undefined> = [];
    const connection = await connect(sandbox, { onShutdown: reason => shutdowns.push(reason) });
    try {
      await waitFor(() => sandbox.helloFrames.length === 1);
      sandbox.send({ type: 'shutdown', reason: 'hello_rejected' });
      await waitFor(() => shutdowns.length === 1);
      sandbox.setMode('reject');
      sandbox.send({ type: 'shutdown', reason: 'hello_rejected' });
      connection.recycle();
      await Bun.sleep(80);
      expect(shutdowns).toEqual(['hello_rejected']);
      expect(sandbox.attempts()).toBe(1);
      expect(sandbox.connectionCount()).toBe(1);
    } finally {
      connection.close();
      sandbox.stop();
    }
  });

  it('recycles the connection on demand', async () => {
    const sandbox = createFakeSandbox();
    let connected = 0;
    const connection = await connect(sandbox, { onConnected: () => (connected += 1) });
    try {
      await waitFor(() => connected === 1);
      connection.recycle();
      await waitFor(() => sandbox.connectionCount() === 2);
      await waitFor(() => sandbox.helloFrames.length === 2);
      await waitFor(() => connected === 2);
      expect(sandbox.helloFrames[1]?.wrapperId).toBe('wrapper-1');
    } finally {
      connection.close();
      sandbox.stop();
    }
  });

  it('bounds the outbound buffer, drops oldest events and sends one marker', async () => {
    const sandbox = createFakeSandbox();
    sandbox.setMode('reject');
    const connection = await connect(sandbox, { outboxMaxFrames: 10 });
    try {
      for (let index = 0; index < 15; index += 1) {
        connection.send({
          type: 'session.events',
          sessionId: 'session-1',
          events: [{ type: `event.${index}`, properties: {} }],
        });
      }
      connection.send({
        type: 'session.outcome',
        sessionId: 'session-1',
        status: 'completed',
        lastMessageId: 'message-1',
      });
      sandbox.setMode('accept');
      await waitFor(() => sandbox.frames.some(frame => frame.type === 'events_dropped'));
      const markers = sandbox.frames.filter((frame): frame is EventsDroppedFrame =>
        isFrame(frame, 'events_dropped')
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]?.dropped).toBe(6);
      const events = sandbox.frames.filter((frame): frame is EventsFrame =>
        isFrame(frame, 'session.events')
      );
      expect(events).toHaveLength(9);
      expect(events[0]?.events[0]?.type).toBe('event.6');
      expect(sandbox.frames.some(frame => frame.type === 'session.outcome')).toBe(true);
    } finally {
      connection.close();
      sandbox.stop();
    }
  });
});
