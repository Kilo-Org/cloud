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
  closes = 0;
  constructor() {
    TestSocket.instances.push(this);
  }
  send(text: string): void {
    this.frames.push(JSON.parse(text));
  }
  close(): void {
    this.closes += 1;
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
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

describe('acknowledged heartbeat', () => {
  it.each(['connected', 'awaiting_welcome', 'connecting'] as const)(
    'recycles %s immediately without waiting for close or retaining old timers',
    async phase => {
      await withTestSocket(async (connection, socket, disconnected) => {
        if (phase === 'connected')
          socket.receive({ type: 'welcome', protocolVersion: 2, heartbeatAck: true });
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
        socket.receive({ type: 'welcome', protocolVersion: 2, heartbeatAck: true });
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
        protocolVersion: 2,
      });
      socket.receive({ type: 'welcome', protocolVersion: 2 });
      await Bun.sleep(120);
      expect(disconnected).toEqual([]);
      expect(TestSocket.instances).toHaveLength(1);
    });
  });

  it('starts at welcome, resets only on ack and reconnects without a close callback', async () => {
    await withTestSocket(async (_connection, socket, disconnected) => {
      await Bun.sleep(100);
      expect(disconnected).toEqual([]);
      socket.receive({ type: 'welcome', protocolVersion: 2, heartbeatAck: true });
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
      replacement.receive({ type: 'welcome', protocolVersion: 2, heartbeatAck: true });
      socket.receive({ type: 'shutdown', reason: 'stale' });
      socket.receive({ type: 'heartbeat_ack' });
      socket.onclose?.();
      await waitFor(() => TestSocket.instances.length === 3);
      expect(disconnected).toHaveLength(2);
    });
  });

  it('shutdown is terminal with a watchdog and pending negotiation', async () => {
    await withTestSocket(async (connection, socket, disconnected) => {
      socket.receive({ type: 'welcome', protocolVersion: 2, heartbeatAck: true });
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
