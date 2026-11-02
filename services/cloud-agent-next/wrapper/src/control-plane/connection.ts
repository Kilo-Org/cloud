import {
  WORKTREE_RUNTIME_HEADER,
  WORKTREE_RUNTIME_VERSION,
  WORKSPACE_CONFIGURATION_HEADER,
  WORKSPACE_CONFIGURATION_VERSION,
} from '../../../src/shared/control-plane-runtime-contract.js';
import {
  CONTROL_PLANE_IDLE_HEARTBEAT_FRAME,
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

/** An outcome the Sandbox DO has not acknowledged is resent after this long. */
export const CONTROL_PLANE_OUTCOME_RESEND_MS = 15_000;
/** An outcome unacknowledged this long is dropped; the Session DO backstop settles its turn. */
export const CONTROL_PLANE_OUTCOME_RETENTION_MS = 10 * 60_000;
/** At most this many outcomes await acknowledgement; the oldest is dropped beyond it. */
export const CONTROL_PLANE_PENDING_OUTCOMES_MAX = 256;

const RECONNECT_JITTER_DIVISOR = 4;

const HELLO_CAPABILITIES = {
  heartbeatAck: true,
  idleHeartbeats: true,
  outcomeAcks: true,
  sessionSnapshots: true,
  redactsNamedSecrets: true,
  installsSkillsSh: true,
} as const;

/**
 * Older Workers reject unknown hello fields with their strict frame schema, so a
 * capability-bearing hello is retried with each previous capability set in turn,
 * then with the original hello that every supported Worker accepts.
 */
const FALLBACK_HELLO_CAPABILITIES = [
  { heartbeatAck: true, sessionSnapshots: true, redactsNamedSecrets: true, installsSkillsSh: true },
  { heartbeatAck: true, redactsNamedSecrets: true, installsSkillsSh: true },
  {},
] as const;

/**
 * Spec §7 Connection: events are evicted first, then display-only route progress. Route
 * transitions, outcomes and request results are never evicted; at capacity the newest is rejected.
 */
type OutboxKind = 'event' | 'progress' | 'critical';

const OUTBOX_EVICTABLE_BY: Record<OutboxKind, readonly OutboxKind[]> = {
  event: ['event'],
  progress: ['event', 'progress'],
  critical: ['event', 'progress'],
};

function outboxKindOf(frame: ControlPlaneWrapperFrame): OutboxKind {
  if (frame.type === 'session.events') return 'event';
  if (frame.type === 'session.progress') return 'progress';
  return 'critical';
}

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
  outcomeResendMs?: number;
  outcomeRetentionMs?: number;
  now?: () => number;
  onNativeDiagnostic?: ControlDiagnosticReporter;
};

type OutcomeFrame = Extract<ControlPlaneWrapperFrame, { type: 'session.outcome' }>;

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
  const outcomeResendMs = options.outcomeResendMs ?? CONTROL_PLANE_OUTCOME_RESEND_MS;
  const outcomeRetentionMs = options.outcomeRetentionMs ?? CONTROL_PLANE_OUTCOME_RETENTION_MS;
  const now = options.now ?? Date.now;
  const WebSocketWithHeaders = WebSocket as unknown as WebSocketWithHeadersCtor;

  type Phase = ControlPlaneConnectionPhase;
  type OutboxEntry = {
    serialized: string;
    bytes: number;
    kind: OutboxKind;
    outcome?: { id: string; frame: OutcomeFrame };
  };
  /** A written outcome the Sandbox DO has not acknowledged. */
  type PendingOutcome = { frame: OutcomeFrame; firstSentAt: number; lastSentAt: number };

  let phase: Phase = 'idle';
  let socket: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let negotiationTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatAck = false;
  // Negotiated in `welcome` for the current connection.
  let idleHeartbeats = false;
  let outcomeAcks = false;
  // Whether the Sandbox DO has seen a full idle heartbeat since the last non-idle one.
  let idleReported = false;
  const pendingOutcomes = new Map<string, PendingOutcome>();
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

  function exceedsCapacity(frames: number, bytes: number): boolean {
    return frames > maxFrames || bytes > maxBytes;
  }

  function enqueue(entry: OutboxEntry, type: ControlPlaneWrapperFrame['type']): void {
    const { kind, bytes } = entry;
    const evictable = OUTBOX_EVICTABLE_BY[kind];
    let keptFrames = 1;
    let keptBytes = bytes;
    for (const entry of outbox) {
      if (evictable.includes(entry.kind)) continue;
      keptFrames += 1;
      keptBytes += entry.bytes;
    }
    if (exceedsCapacity(keptFrames, keptBytes)) {
      if (kind === 'event') droppedEvents += 1;
      log(`control-plane outbox rejected the newest ${type} frame at capacity`);
      return;
    }
    for (const victim of evictable) {
      while (exceedsCapacity(outbox.length + 1, outboxBytes + bytes)) {
        const index = outbox.findIndex(entry => entry.kind === victim);
        if (index < 0) break;
        const [removed] = outbox.splice(index, 1);
        if (!removed) break;
        outboxBytes -= removed.bytes;
        if (removed.kind === 'event') droppedEvents += 1;
      }
    }
    outbox.push(entry);
    outboxBytes += bytes;
  }

  function write(target: WebSocket, serialized: string): boolean {
    if (target.readyState !== WebSocket.OPEN) {
      reconnectSocket(target, 'socket not open');
      return false;
    }
    try {
      target.send(serialized);
      return true;
    } catch {
      reconnectSocket(target, 'send failed');
      return false;
    }
  }

  function writeRaw(target: WebSocket, frame: ControlPlaneWrapperFrame): boolean {
    return write(target, JSON.stringify(frame));
  }

  function serializeOutcome(id: string, frame: OutcomeFrame): string {
    return JSON.stringify({ ...frame, outcomeId: id });
  }

  function trackOutcome(id: string, frame: OutcomeFrame): void {
    const at = now();
    const previous = pendingOutcomes.get(id);
    pendingOutcomes.set(id, {
      frame,
      firstSentAt: previous?.firstSentAt ?? at,
      lastSentAt: at,
    });
    if (pendingOutcomes.size <= CONTROL_PLANE_PENDING_OUTCOMES_MAX) return;
    const oldest = pendingOutcomes.keys().next().value;
    if (oldest !== undefined) pendingOutcomes.delete(oldest);
    log('control-plane dropped the oldest unacknowledged outcome at capacity');
  }

  /** Writes one outbox entry; an outcome carries its id only where acknowledged. */
  function writeEntry(target: WebSocket, entry: OutboxEntry): boolean {
    const outcome = outcomeAcks ? entry.outcome : undefined;
    if (!write(target, outcome ? serializeOutcome(outcome.id, outcome.frame) : entry.serialized))
      return false;
    if (outcome) trackOutcome(outcome.id, outcome.frame);
    return true;
  }

  /** Resends each unacknowledged outcome `due` selects; false when the socket failed. */
  function resendOutcomes(target: WebSocket, due: (pending: PendingOutcome) => boolean): boolean {
    for (const [id, pending] of pendingOutcomes) {
      if (now() - pending.firstSentAt >= outcomeRetentionMs) {
        pendingOutcomes.delete(id);
        log(`control-plane gave up on unacknowledged outcome for ${pending.frame.sessionId}`);
        continue;
      }
      if (!due(pending)) continue;
      // A peer without acknowledgements (a rolled-back Worker) rejects the id.
      if (!outcomeAcks) {
        if (!writeRaw(target, pending.frame)) return false;
        continue;
      }
      if (!write(target, serializeOutcome(id, pending.frame))) return false;
      trackOutcome(id, pending.frame);
    }
    return true;
  }

  function flushOutbox(target: WebSocket): boolean {
    if (droppedEvents > 0) {
      if (!writeRaw(target, { type: 'events_dropped', dropped: droppedEvents })) return false;
      droppedEvents = 0;
    }
    while (outbox.length > 0) {
      const entry = outbox[0];
      if (!entry) break;
      if (!writeEntry(target, entry)) return false;
      outbox.shift();
      outboxBytes -= entry.bytes;
    }
    return true;
  }

  function stopHandshake(): void {
    clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
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

  function armNegotiationFallback(target: WebSocket, index: number): void {
    negotiationTimer = setTimeout(() => {
      if (socket !== target || phase !== 'awaiting_welcome') return;
      negotiationTimer = undefined;
      if (
        !writeRaw(target, {
          type: 'hello',
          wrapperId,
          allocationId: options.allocationId,
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          ...(FALLBACK_HELLO_CAPABILITIES[index] ?? {}),
        })
      )
        return;
      if (index + 1 < FALLBACK_HELLO_CAPABILITIES.length) armNegotiationFallback(target, index + 1);
    }, options.timers.wrapper.heartbeatNegotiationMs);
  }

  function armAckDeadline(target: WebSocket): void {
    clearTimeout(ackTimer);
    const deadline = setTimeout(() => {
      if (ackTimer !== deadline || socket !== target || phase !== 'connected' || !heartbeatAck)
        return;
      reconnectSocket(target, 'heartbeat acknowledgement timeout');
    }, options.timers.wrapper.heartbeatAckTimeoutMs);
    ackTimer = deadline;
  }

  function startHeartbeat(target: WebSocket, acknowledged: boolean): void {
    stopHeartbeat();
    heartbeatAck = acknowledged;
    idleReported = false;
    if (heartbeatAck) armAckDeadline(target);
    heartbeatTimer = setInterval(() => {
      if (socket !== target || phase !== 'connected') return;
      const heartbeat = options.getHeartbeat?.() ?? { active: false, degraded: false };
      const idle = !heartbeat.active && !heartbeat.degraded;
      // The first idle heartbeat is a full frame so the Sandbox DO observes the
      // transition; the rest are auto-answered without waking it.
      if (idle && idleHeartbeats && idleReported) {
        if (!write(target, CONTROL_PLANE_IDLE_HEARTBEAT_FRAME)) return;
      } else {
        if (
          !writeRaw(target, {
            type: 'heartbeat',
            active: heartbeat.active,
            degraded: heartbeat.degraded,
          })
        )
          return;
        idleReported = idle;
      }
      resendOutcomes(target, pending => now() - pending.lastSentAt >= outcomeResendMs);
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
    stopHandshake();
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
    stopHandshake();
    stopHeartbeat();
    if (phase === 'closed') return;
    if (wasConnected) reportDisconnectEpisode('closed');
    else if (wasConnecting) reportDisconnectEpisode('connect_attempt');
    phase = 'idle';
    if (wasConnected) options.onDisconnected?.(reason);
    scheduleReconnect();
  }

  function reconnectSocket(target: WebSocket, reason: string): void {
    if (socket !== target) return;
    log(`control-plane socket ended: ${reason}`);
    onSocketEnd(target, reason);
    try {
      target.close(1000, reason);
    } catch {
      log('control-plane failed socket close failed');
    }
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
      stopHandshake();
      idleHeartbeats = frame.idleHeartbeats === true;
      outcomeAcks = frame.outcomeAcks === true;
      // Outcomes written on an earlier connection precede everything queued since.
      if (!resendOutcomes(target, () => true)) return;
      if (!outcomeAcks) pendingOutcomes.clear();
      if (!flushOutbox(target)) return;
      phase = 'connected';
      disconnectEpisodeReported = false;
      attempt = 0;
      startHeartbeat(target, frame.heartbeatAck === true);
      options.onConnected?.();
      return;
    }
    if (frame.type === 'heartbeat_ack') {
      if (phase === 'connected' && heartbeatAck) armAckDeadline(target);
      return;
    }
    if (frame.type === 'session.outcome_ack') {
      pendingOutcomes.delete(frame.outcomeId);
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
        headers: {
          Authorization: `Bearer ${options.credential}`,
          [WORKTREE_RUNTIME_HEADER]: WORKTREE_RUNTIME_VERSION,
          [WORKSPACE_CONFIGURATION_HEADER]: WORKSPACE_CONFIGURATION_VERSION,
        },
      });
    } catch (error) {
      log(`control-plane connection failed: ${messageOf(error)}`);
      reportDisconnectEpisode('connect_attempt');
      phase = 'idle';
      scheduleReconnect();
      return;
    }
    socket = target;
    const deadline = setTimeout(() => {
      if (
        handshakeTimer !== deadline ||
        socket !== target ||
        (phase !== 'connecting' && phase !== 'awaiting_welcome')
      )
        return;
      reconnectSocket(target, 'handshake timeout');
    }, options.timers.wrapper.handshakeMs);
    handshakeTimer = deadline;
    target.onopen = () => {
      if (socket !== target || phase !== 'connecting') return;
      phase = 'awaiting_welcome';
      if (
        !writeRaw(target, {
          type: 'hello',
          wrapperId,
          allocationId: options.allocationId,
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          ...HELLO_CAPABILITIES,
        })
      )
        return;
      armNegotiationFallback(target, 0);
    };
    target.onmessage = event => onMessage(target, event);
    target.onclose = () => onSocketEnd(target, 'connection closed');
    target.onerror = () => reconnectSocket(target, 'connection error');
  }

  function start(): void {
    if (phase !== 'idle' || reconnectTimer !== undefined) return;
    connect();
  }

  function send(frame: ControlPlaneWrapperFrame): void {
    if (phase === 'closed') return;
    let entry: OutboxEntry;
    try {
      const serialized = JSON.stringify(frame);
      const outcome =
        frame.type === 'session.outcome' ? { id: crypto.randomUUID(), frame } : undefined;
      entry = {
        serialized,
        bytes: Buffer.byteLength(serialized),
        kind: outboxKindOf(frame),
        ...(outcome ? { outcome } : {}),
      };
    } catch {
      return;
    }
    if (phase === 'connected' && socket && writeEntry(socket, entry)) return;
    enqueue(entry, frame.type);
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
    pendingOutcomes.clear();
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopHandshake();
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
