import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  controlPlaneWrapperFrameSchema,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type {
  ControlDiagnosticReporter,
  NativeConnectionPhase,
} from '../../../src/shared/control-diagnostics.js';
import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';

/** Spec §7 Connection: the bounded outbound buffer holds at most this many frames. */
export const CONTROL_PLANE_OUTBOX_MAX_FRAMES = 1_000;
/** Spec §7 Connection: the bounded outbound buffer holds at most this many bytes. */
export const CONTROL_PLANE_OUTBOX_MAX_BYTES = 8 * 1024 * 1024;

const RECONNECT_JITTER_DIVISOR = 4;

type WebSocketWithHeadersCtor = new (
  url: string,
  options?: { headers?: Record<string, string> }
) => WebSocket;

export type ControlPlaneHeartbeat = { active: boolean; degraded: boolean };

/** The live connection phase, derived from the shared tuple so it cannot drift. */
export type ControlPlaneConnectionPhase = NativeConnectionPhase;

export type ControlPlaneConnectionSnapshot = {
  phase: ControlPlaneConnectionPhase;
  attempt: number;
  outboxBytes: number;
};

export type ControlPlaneConnectionOptions = {
  url: string;
  credential: string;
  allocationId: string;
  timers: ControlPlaneTimers;
  wrapperId?: string;
  log?: (message: string) => void;
  getHeartbeat?: () => ControlPlaneHeartbeat;
  onFrame?: (frame: ControlPlaneWrapperFrame) => void;
  onShutdown?: (reason: string | undefined) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  random?: () => number;
  outboxMaxFrames?: number;
  outboxMaxBytes?: number;
  onNativeDiagnostic?: ControlDiagnosticReporter;
};

export type ControlPlaneConnection = {
  /** The wrapper identity advertised in `hello` (B10 terminal records). */
  readonly wrapperId: string;
  /** The live phase, reconnect attempt and buffered bytes, without a recount. */
  snapshot(): ControlPlaneConnectionSnapshot;
  start(): void;
  send(frame: ControlPlaneWrapperFrame): void;
  recycle(): void;
  close(): void;
};

/**
 * Spec §7 Connection: exponential backoff from `reconnectBackoffMinMs` to
 * `reconnectBackoffMaxMs`, plus jitter, for every reconnect attempt.
 */
export function controlPlaneReconnectDelayMs(
  timers: ControlPlaneTimers,
  attempt: number,
  random: () => number
): number {
  const min = timers.wrapper.reconnectBackoffMinMs;
  const max = timers.wrapper.reconnectBackoffMaxMs;
  const base = Math.min(max, min * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(random() * Math.max(1, Math.floor(min / RECONNECT_JITTER_DIVISOR)));
  return base + jitter;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toText(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return undefined;
}

export function createControlPlaneConnection(
  options: ControlPlaneConnectionOptions
): ControlPlaneConnection {
  const log = options.log ?? ((): void => undefined);
  const random = options.random ?? Math.random;
  const wrapperId = options.wrapperId ?? crypto.randomUUID();
  const maxFrames = options.outboxMaxFrames ?? CONTROL_PLANE_OUTBOX_MAX_FRAMES;
  const maxBytes = options.outboxMaxBytes ?? CONTROL_PLANE_OUTBOX_MAX_BYTES;
  const WebSocketWithHeaders = WebSocket as unknown as WebSocketWithHeadersCtor;

  type Phase = ControlPlaneConnectionPhase;
  type OutboxEntry = { serialized: string; bytes: number; droppable: boolean };

  let phase: Phase = 'idle';
  let socket: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let negotiationTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatAck = false;
  const outbox: OutboxEntry[] = [];
  let outboxBytes = 0;
  let droppedEvents = 0;
  // One native stderr line per disconnected episode. `welcome` arms the next.
  let disconnectEpisodeReported = false;

  function reportSocketLine(phase: 'closed' | 'connect_attempt' | 'hello_rejected'): void {
    try {
      options.onNativeDiagnostic?.('control.socket', {
        phase,
        ...(phase === 'connect_attempt' ? { ok: false } : {}),
        allocationId: options.allocationId,
        wrapperInstanceId: wrapperId,
      });
    } catch {
      // The projector must never disturb the connection.
    }
  }

  function reportDisconnectEpisode(phase: 'closed' | 'connect_attempt'): void {
    if (disconnectEpisodeReported) return;
    disconnectEpisodeReported = true;
    reportSocketLine(phase);
  }

  function isDroppable(frame: ControlPlaneWrapperFrame): boolean {
    return frame.type === 'session.events';
  }

  function enqueue(serialized: string, droppable: boolean): void {
    const bytes = Buffer.byteLength(serialized);
    if (bytes > maxBytes) {
      if (droppable) droppedEvents += 1;
      log('control-plane outbox dropped an oversized frame');
      return;
    }
    while (outbox.length >= maxFrames || outboxBytes + bytes > maxBytes) {
      // Keep outcome and route frames: drop the oldest event frame first.
      const droppableIndex = outbox.findIndex(entry => entry.droppable);
      const index = droppableIndex >= 0 ? droppableIndex : 0;
      const [removed] = outbox.splice(index, 1);
      if (!removed) break;
      outboxBytes -= removed.bytes;
      if (removed.droppable) droppedEvents += 1;
      else log('control-plane outbox dropped a non-event frame');
    }
    outbox.push({ serialized, bytes, droppable });
    outboxBytes += bytes;
  }

  function writeRaw(target: WebSocket, frame: ControlPlaneWrapperFrame): void {
    try {
      target.send(JSON.stringify(frame));
    } catch {
      // Best effort; a failed send surfaces through the socket close handler.
    }
  }

  function flushOutbox(target: WebSocket): void {
    if (droppedEvents > 0) {
      // One marker for every event frame dropped while the socket was down.
      writeRaw(target, { type: 'events_dropped', dropped: droppedEvents });
      droppedEvents = 0;
    }
    const pending = outbox.splice(0, outbox.length);
    outboxBytes = 0;
    for (const entry of pending) {
      try {
        target.send(entry.serialized);
      } catch {
        log('control-plane outbox send failed after reconnect');
      }
    }
  }

  function stopHeartbeat(): void {
    heartbeatAck = false;
    clearTimeout(ackTimer);
    ackTimer = undefined;
    clearTimeout(negotiationTimer);
    negotiationTimer = undefined;
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function armAckDeadline(target: WebSocket): void {
    clearTimeout(ackTimer);
    const deadline = setTimeout(() => {
      if (ackTimer !== deadline || socket !== target || phase !== 'connected' || !heartbeatAck)
        return;
      onSocketEnd(target, 'heartbeat acknowledgement timeout');
      try {
        target.close(1000, 'heartbeat acknowledgement timeout');
      } catch {
        log('control-plane timed-out socket close failed');
      }
    }, options.timers.wrapper.heartbeatAckTimeoutMs);
    ackTimer = deadline;
  }

  function startHeartbeat(target: WebSocket, acknowledged: boolean): void {
    stopHeartbeat();
    heartbeatAck = acknowledged;
    if (heartbeatAck) armAckDeadline(target);
    heartbeatTimer = setInterval(() => {
      if (socket !== target || phase !== 'connected') return;
      const heartbeat = options.getHeartbeat?.() ?? { active: false, degraded: false };
      writeRaw(target, {
        type: 'heartbeat',
        active: heartbeat.active,
        degraded: heartbeat.degraded,
      });
    }, options.timers.wrapper.heartbeatIntervalMs);
  }

  function scheduleReconnect(): void {
    if (phase === 'closed') return;
    attempt += 1;
    const delay = controlPlaneReconnectDelayMs(options.timers, attempt, random);
    log(`control-plane reconnect in ${delay}ms (attempt ${attempt})`);
    const pending = setTimeout(() => {
      if (reconnectTimer !== pending) return;
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer = pending;
  }

  function detachAndReconnect(): void {
    const wasConnected = phase === 'connected';
    attempt = 0;
    stopHeartbeat();
    const previous = socket;
    socket = null;
    phase = 'idle';
    if (previous) {
      try {
        previous.close(1000, 'recycle');
      } catch {
        // Already closing.
      }
    }
    if (wasConnected) options.onDisconnected?.('connection recycled');
    connect();
  }

  function onSocketEnd(target: WebSocket, reason: string): void {
    if (socket !== target) return;
    const wasConnected = phase === 'connected';
    const wasConnecting = phase === 'connecting' || phase === 'awaiting_welcome';
    socket = null;
    stopHeartbeat();
    if (phase === 'closed') return;
    if (wasConnected) reportDisconnectEpisode('closed');
    else if (wasConnecting) reportDisconnectEpisode('connect_attempt');
    phase = 'idle';
    if (wasConnected) options.onDisconnected?.(reason);
    scheduleReconnect();
  }

  function onMessage(target: WebSocket, event: MessageEvent): void {
    if (socket !== target || phase === 'closed') return;
    const text = toText(event.data);
    if (text === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const result = controlPlaneWrapperFrameSchema.safeParse(parsed);
    if (!result.success) {
      log('control-plane ignored an invalid frame');
      return;
    }
    const frame = result.data;
    if (frame.type === 'welcome') {
      if (phase !== 'awaiting_welcome') return;
      disconnectEpisodeReported = false;
      phase = 'connected';
      attempt = 0;
      startHeartbeat(target, frame.heartbeatAck === true);
      flushOutbox(target);
      options.onConnected?.();
      return;
    }
    if (frame.type === 'heartbeat_ack') {
      if (phase === 'connected' && heartbeatAck) armAckDeadline(target);
      return;
    }
    if (frame.type === 'shutdown') {
      close();
      if (frame.reason === 'hello_rejected') reportSocketLine('hello_rejected');
      options.onShutdown?.(frame.reason);
      return;
    }
    options.onFrame?.(frame);
  }

  function connect(): void {
    if (phase === 'closed') return;
    phase = 'connecting';
    let target: WebSocket;
    try {
      target = new WebSocketWithHeaders(options.url, {
        headers: { Authorization: `Bearer ${options.credential}` },
      });
    } catch (error) {
      log(`control-plane connection failed: ${messageOf(error)}`);
      reportDisconnectEpisode('connect_attempt');
      scheduleReconnect();
      return;
    }
    socket = target;
    target.onopen = () => {
      if (socket !== target || phase === 'closed') return;
      phase = 'awaiting_welcome';
      writeRaw(target, {
        type: 'hello',
        wrapperId,
        allocationId: options.allocationId,
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        heartbeatAck: true,
      });
      // Older v2 peers strictly reject the capability-bearing hello.
      negotiationTimer = setTimeout(() => {
        if (socket !== target || phase !== 'awaiting_welcome') return;
        negotiationTimer = undefined;
        writeRaw(target, {
          type: 'hello',
          wrapperId,
          allocationId: options.allocationId,
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        });
      }, options.timers.wrapper.heartbeatNegotiationMs);
    };
    target.onmessage = event => onMessage(target, event);
    target.onclose = () => onSocketEnd(target, 'connection closed');
    target.onerror = () => {
      // Bun fires `error` and then `close`; the close handler drives reconnect.
      // The episode latch makes the pair one native line. A deliberate recycle
      // is not a failure.
      if (socket !== target || phase === 'closed') return;
      if (phase === 'connected') reportDisconnectEpisode('closed');
      else if (phase === 'connecting' || phase === 'awaiting_welcome') {
        reportDisconnectEpisode('connect_attempt');
      }
    };
  }

  function start(): void {
    if (phase !== 'idle') return;
    connect();
  }

  function send(frame: ControlPlaneWrapperFrame): void {
    if (phase === 'closed') return;
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
    } catch {
      return;
    }
    if (phase === 'connected' && socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(serialized);
        return;
      } catch {
        // Buffer below and reconnect.
      }
    }
    enqueue(serialized, isDroppable(frame));
  }

  function recycle(): void {
    if (phase === 'closed') return;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    detachAndReconnect();
  }

  function close(): void {
    if (phase === 'closed') return;
    phase = 'closed';
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopHeartbeat();
    const current = socket;
    socket = null;
    if (current) {
      try {
        current.close(1000, 'closed');
      } catch {
        // Already closing.
      }
    }
  }

  return {
    wrapperId,
    snapshot: () => ({ phase, attempt, outboxBytes }),
    start,
    send,
    recycle,
    close,
  };
}
