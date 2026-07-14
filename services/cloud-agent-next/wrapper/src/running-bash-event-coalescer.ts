import type { IngestEvent } from '../../src/shared/protocol.js';

const DEFAULT_COALESCE_INTERVAL_MS = 150;

type Scheduler = (callback: () => void, delayMs: number) => () => void;

type ThrottledPart = {
  sessionId: string;
  latest?: IngestEvent;
  latestSequence?: number;
  cancel: () => void;
};

type BashPartUpdate = {
  key: string;
  sessionId: string;
  running: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function partKey(sessionId: string, messageId: string, partId: string): string {
  return JSON.stringify([sessionId, messageId, partId]);
}

function classifyBashPartUpdate(event: IngestEvent): BashPartUpdate | undefined {
  if (event.streamEventType !== 'kilocode' || !isRecord(event.data)) return undefined;
  if (event.data.event !== 'message.part.updated') return undefined;
  const properties = event.data.properties;
  if (!isRecord(properties)) return undefined;
  const part = properties.part;
  if (!isRecord(part) || part.type !== 'tool' || part.tool !== 'bash') return undefined;
  if (
    typeof part.sessionID !== 'string' ||
    typeof part.messageID !== 'string' ||
    typeof part.id !== 'string'
  ) {
    return undefined;
  }
  const state = part.state;
  return {
    key: partKey(part.sessionID, part.messageID, part.id),
    sessionId: part.sessionID,
    running: isRecord(state) && state.status === 'running',
  };
}

function removedPartKey(event: IngestEvent): string | undefined {
  if (event.streamEventType !== 'kilocode' || !isRecord(event.data)) return undefined;
  if (event.data.event !== 'message.part.removed') return undefined;
  const properties = event.data.properties;
  if (
    !isRecord(properties) ||
    typeof properties.sessionID !== 'string' ||
    typeof properties.messageID !== 'string' ||
    typeof properties.partID !== 'string'
  ) {
    return undefined;
  }
  return partKey(properties.sessionID, properties.messageID, properties.partID);
}

function sessionIdFromProperties(properties: unknown): string | undefined {
  return isRecord(properties) && typeof properties.sessionID === 'string'
    ? properties.sessionID
    : undefined;
}

function classifyBoundary(event: IngestEvent): { sessionId?: string } | undefined {
  if (
    event.streamEventType === 'complete' ||
    event.streamEventType === 'error' ||
    event.streamEventType === 'interrupted'
  ) {
    return {};
  }
  if (event.streamEventType !== 'kilocode' || !isRecord(event.data)) return undefined;
  if (
    event.data.event === 'session.idle' ||
    event.data.event === 'session.error' ||
    event.data.event === 'payment_required' ||
    event.data.event === 'insufficient_funds'
  ) {
    return { sessionId: sessionIdFromProperties(event.data.properties) };
  }
  if (event.data.event !== 'message.updated') return undefined;
  const properties = event.data.properties;
  if (!isRecord(properties)) return undefined;
  const info = properties.info;
  if (!isRecord(info) || info.role !== 'assistant') return undefined;
  const time = info.time;
  if (!((isRecord(time) && typeof time.completed === 'number') || info.error != null)) {
    return undefined;
  }
  return { sessionId: typeof info.sessionID === 'string' ? info.sessionID : undefined };
}

const defaultScheduler: Scheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createRunningBashEventCoalescer(
  send: (event: IngestEvent) => void,
  schedule: Scheduler = defaultScheduler,
  intervalMs = DEFAULT_COALESCE_INTERVAL_MS
) {
  const throttledParts = new Map<string, ThrottledPart>();
  let nextSequence = 0;
  let closed = false;

  function scheduleThrottleExpiry(partKey: string): () => void {
    return schedule(() => {
      const part = throttledParts.get(partKey);
      if (!part) return;
      if (part.latest && !closed) {
        const latest = part.latest;
        part.latest = undefined;
        part.latestSequence = undefined;
        send(latest);
        part.cancel = scheduleThrottleExpiry(partKey);
        return;
      }
      throttledParts.delete(partKey);
    }, intervalMs);
  }

  function cancelPart(partKey: string): void {
    const part = throttledParts.get(partKey);
    if (!part) return;
    part.cancel();
    throttledParts.delete(partKey);
  }

  function flushAll(): void {
    const updates: Array<{ event: IngestEvent; sequence: number }> = [];
    for (const part of throttledParts.values()) {
      part.cancel();
      if (part.latest && part.latestSequence !== undefined) {
        updates.push({ event: part.latest, sequence: part.latestSequence });
      }
    }
    throttledParts.clear();
    updates.sort((left, right) => left.sequence - right.sequence);
    if (!closed) {
      for (const update of updates) send(update.event);
    }
  }

  function flushSession(sessionId: string): void {
    const updates: Array<{ event: IngestEvent; sequence: number }> = [];
    for (const [key, part] of throttledParts) {
      if (part.sessionId !== sessionId) continue;
      part.cancel();
      if (part.latest && part.latestSequence !== undefined) {
        updates.push({ event: part.latest, sequence: part.latestSequence });
      }
      throttledParts.delete(key);
    }
    updates.sort((left, right) => left.sequence - right.sequence);
    if (!closed) {
      for (const update of updates) send(update.event);
    }
  }

  function forward(event: IngestEvent): void {
    if (closed) return;

    const bashPart = classifyBashPartUpdate(event);
    if (bashPart?.running) {
      const existing = throttledParts.get(bashPart.key);
      if (existing) {
        existing.latest = event;
        existing.latestSequence = nextSequence++;
        return;
      }
      send(event);
      throttledParts.set(bashPart.key, {
        sessionId: bashPart.sessionId,
        cancel: scheduleThrottleExpiry(bashPart.key),
      });
      return;
    }

    if (bashPart) {
      cancelPart(bashPart.key);
    } else {
      const removedKey = removedPartKey(event);
      if (removedKey) {
        cancelPart(removedKey);
      } else {
        const boundary = classifyBoundary(event);
        if (boundary) {
          if (boundary.sessionId) flushSession(boundary.sessionId);
          else flushAll();
        }
      }
    }
    send(event);
  }

  function close(): void {
    flushAll();
    closed = true;
  }

  function reopen(): void {
    for (const part of throttledParts.values()) part.cancel();
    throttledParts.clear();
    closed = false;
    nextSequence = 0;
  }

  return { forward, close, reopen };
}
