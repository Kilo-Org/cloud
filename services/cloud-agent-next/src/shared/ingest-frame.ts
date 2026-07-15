/**
 * Ingest frame budgeting for the wrapper -> Durable Object `/ingest` WebSocket.
 *
 * Cloudflare closes a WebSocket with `1009` when a single received message
 * exceeds its per-message limit, and Durable Object SQLite has a much smaller
 * practical limit for persisted row/string/blob values. Both failures are
 * avoided by never sending an unbounded serialized event.
 *
 * Every ingest send goes through `prepareIngestFrame`, which:
 *   1. applies the existing payload trimming,
 *   2. serializes once and measures UTF-8 byte length,
 *   3. sends when under the safe budget,
 *   4. compacts (or replaces with a small internal surrogate) when oversized,
 *   5. drops only as a last resort.
 *
 * Terminal/lifecycle signals are never silently dropped: oversized terminal
 * events are reduced to a compact form that preserves message IDs, terminal
 * status, failure code, and safe error text.
 */

import { trimPayload } from './trim-payload.js';
import type { IngestEvent, StreamEventType, WrapperEventTruncatedData } from './protocol.js';

/** Cloudflare's per-WebSocket-message receive limit. Documentation/logging only. */
export const CLOUDFLARE_WEBSOCKET_RECEIVE_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Enforced per-frame send budget. Kept well below the platform 32 MiB limit
 * because the DO may persist and replay the payload, and SQLite row/string/blob
 * limits are much closer to ~2 MB.
 */
export const MAX_INGEST_EVENT_BYTES = 1 * 1024 * 1024;

/** Disconnected-buffer memory budget (count cap is secondary to this). */
export const MAX_INGEST_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Secondary disconnected-buffer count cap. */
export const MAX_INGEST_BUFFER_COUNT = 1000;

const encoder = new TextEncoder();

function byteLength(serialized: string): number {
  return encoder.encode(serialized).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= max) return value;
  return value.slice(0, max) + '\n\n[…truncated]';
}

/**
 * Stream event types that carry terminal/lifecycle meaning and must survive
 * compaction rather than being replaced by a truncation surrogate.
 */
export const TERMINAL_INGEST_STREAM_EVENT_TYPES: ReadonlySet<StreamEventType> = new Set([
  'complete',
  'interrupted',
  'error',
  'cloud.message.completed',
  'wrapper_finalizing',
  'autocommit_started',
  'autocommit_completed',
]);

export function isLifecycleIngestEvent(event: IngestEvent): boolean {
  return TERMINAL_INGEST_STREAM_EVENT_TYPES.has(event.streamEventType);
}

export function kiloEventNameOf(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const name = data.event ?? data.type;
  return typeof name === 'string' ? name : undefined;
}

function compactTerminalData(streamEventType: StreamEventType, data: unknown): unknown {
  if (!isRecord(data)) return {};
  switch (streamEventType) {
    case 'complete': {
      const out: Record<string, unknown> = {
        exitCode: typeof data.exitCode === 'number' ? data.exitCode : 0,
      };
      if (typeof data.currentBranch === 'string') out.currentBranch = data.currentBranch;
      if (data.gateResult === 'pass' || data.gateResult === 'fail')
        out.gateResult = data.gateResult;
      if (Array.isArray(data.messageIds)) {
        out.messageIds = data.messageIds.filter((id): id is string => typeof id === 'string');
      }
      return out;
    }
    case 'interrupted': {
      const out: Record<string, unknown> = {};
      const reason = safeString(data.reason, 1000);
      if (reason !== undefined) out.reason = reason;
      if (typeof data.exitCode === 'number') out.exitCode = data.exitCode;
      if (data.interruptionSource === 'container_shutdown')
        out.interruptionSource = data.interruptionSource;
      return out;
    }
    case 'error': {
      const safeError =
        safeString(data.error, 1000) ?? safeString(data.message, 1000) ?? 'Agent wrapper failed';
      const out: Record<string, unknown> = {
        error: safeError,
        message: safeError,
      };
      if (typeof data.fatal === 'boolean') out.fatal = data.fatal;
      if (data.errorSource === 'assistant') out.errorSource = data.errorSource;
      if (typeof data.failureCode === 'string') out.failureCode = data.failureCode;
      // Drop heavy modelNotFoundRuntimeDiagnostics on compaction.
      return out;
    }
    case 'cloud.message.completed': {
      const out: Record<string, unknown> = {
        completionSource: 'manual_compact_summarize',
      };
      if (typeof data.messageId === 'string') out.messageId = data.messageId;
      if (typeof data.assistantMessageId === 'string')
        out.assistantMessageId = data.assistantMessageId;
      return out;
    }
    case 'autocommit_started': {
      const out: Record<string, unknown> = { message: safeString(data.message, 1000) ?? '' };
      if (typeof data.messageId === 'string') out.messageId = data.messageId;
      return out;
    }
    case 'autocommit_completed': {
      const out: Record<string, unknown> = {
        success: typeof data.success === 'boolean' ? data.success : false,
        message: safeString(data.message, 1000) ?? '',
      };
      if (typeof data.messageId === 'string') out.messageId = data.messageId;
      if (typeof data.skipped === 'boolean') out.skipped = data.skipped;
      if (typeof data.commitHash === 'string') out.commitHash = data.commitHash;
      // Drop commitMessage (may be large) on compaction.
      return out;
    }
    case 'wrapper_finalizing': {
      const out: Record<string, unknown> = {};
      if (typeof data.wrapperRunId === 'string') out.wrapperRunId = data.wrapperRunId;
      return out;
    }
    default:
      return {};
  }
}

function compactMessagePartUpdated(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { event: data.event, type: data.type };
  const properties = data.properties;
  if (isRecord(properties)) {
    const compactProps: Record<string, unknown> = {};
    if (typeof properties.sessionID === 'string') compactProps.sessionID = properties.sessionID;
    const part = properties.part;
    if (isRecord(part)) {
      const compactPart: Record<string, unknown> = {};
      if (typeof part.type === 'string') compactPart.type = part.type;
      if (typeof part.id === 'string') compactPart.id = part.id;
      if (typeof part.messageID === 'string') compactPart.messageID = part.messageID;
      if (typeof part.status === 'string') compactPart.status = part.status;
      const state = part.state;
      if (isRecord(state) && typeof state.status === 'string') {
        compactPart.state = { status: state.status };
      }
      compactProps.part = compactPart;
    }
    out.properties = compactProps;
  }
  return out;
}

function compactMessageUpdated(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { event: data.event, type: data.type };
  const properties = data.properties;
  if (isRecord(properties)) {
    const info = properties.info;
    if (isRecord(info)) {
      const compactInfo: Record<string, unknown> = {};
      if (typeof info.id === 'string') compactInfo.id = info.id;
      if (typeof info.parentID === 'string') compactInfo.parentID = info.parentID;
      if (typeof info.sessionID === 'string') compactInfo.sessionID = info.sessionID;
      if (typeof info.role === 'string') compactInfo.role = info.role;
      if (isRecord(info.time)) compactInfo.time = info.time;
      const safeError = safeString(info.error, 2000);
      if (safeError !== undefined) compactInfo.error = safeError;
      out.properties = { info: compactInfo };
    }
  }
  return out;
}

function compactCommandsAvailable(data: Record<string, unknown>): Record<string, unknown> {
  const commands = data.commands;
  if (!Array.isArray(commands)) return { commands: [] };
  return {
    commands: commands
      .filter((c): c is Record<string, unknown> => isRecord(c) && typeof c.name === 'string')
      .map(c => ({ name: c.name as string })),
  };
}

function buildTruncationSurrogate(
  event: IngestEvent,
  originalBytes: number,
  compactedBytes?: number
): IngestEvent {
  const data: WrapperEventTruncatedData = {
    originalStreamEventType: event.streamEventType,
    originalBytes,
    reason: 'oversized_ingest_event',
  };
  const kiloEventName =
    event.streamEventType === 'kilocode' ? kiloEventNameOf(event.data) : undefined;
  if (kiloEventName !== undefined) data.kiloEventName = kiloEventName;
  if (compactedBytes !== undefined) data.compactedBytes = compactedBytes;
  return {
    streamEventType: 'wrapper_event_truncated',
    timestamp: event.timestamp,
    data,
  };
}

function compactIngestEvent(event: IngestEvent, originalBytes: number): IngestEvent {
  const { streamEventType, timestamp, data } = event;
  if (TERMINAL_INGEST_STREAM_EVENT_TYPES.has(streamEventType)) {
    return { streamEventType, timestamp, data: compactTerminalData(streamEventType, data) };
  }
  if (streamEventType === 'kilocode') {
    const kiloEventName = kiloEventNameOf(data);
    if (kiloEventName === 'message.part.updated' && isRecord(data)) {
      return { streamEventType, timestamp, data: compactMessagePartUpdated(data) };
    }
    if (kiloEventName === 'message.updated' && isRecord(data)) {
      return { streamEventType, timestamp, data: compactMessageUpdated(data) };
    }
  }
  if (streamEventType === 'commands.available' && isRecord(data)) {
    return { streamEventType, timestamp, data: compactCommandsAvailable(data) };
  }
  return buildTruncationSurrogate(event, originalBytes);
}

function minimalIngestEvent(event: IngestEvent, originalBytes: number): IngestEvent {
  const { streamEventType, timestamp, data } = event;
  if (TERMINAL_INGEST_STREAM_EVENT_TYPES.has(streamEventType)) {
    let minimalData: unknown = {};
    switch (streamEventType) {
      case 'complete':
        minimalData = {
          exitCode:
            typeof data === 'object' &&
            data &&
            'exitCode' in data &&
            typeof (data as Record<string, unknown>).exitCode === 'number'
              ? (data as Record<string, unknown>).exitCode
              : 0,
        };
        break;
      case 'interrupted':
        minimalData = { reason: 'Wrapper interrupted' };
        break;
      case 'error': {
        const d = data as Record<string, unknown>;
        minimalData = {
          fatal: typeof d?.fatal === 'boolean' ? d.fatal : true,
          error: safeString(d?.error, 1000) ?? 'Agent wrapper failed',
        };
        break;
      }
      case 'cloud.message.completed': {
        const d = data as Record<string, unknown>;
        minimalData =
          typeof d?.messageId === 'string'
            ? { messageId: d.messageId, completionSource: 'manual_compact_summarize' }
            : { completionSource: 'manual_compact_summarize' };
        break;
      }
      case 'autocommit_started':
        minimalData = { message: '' };
        break;
      case 'autocommit_completed':
        minimalData = { success: false, message: '' };
        break;
      case 'wrapper_finalizing':
        minimalData = {};
        break;
    }
    return { streamEventType, timestamp, data: minimalData };
  }
  return buildTruncationSurrogate(event, originalBytes);
}

export type PreparedIngestFrame =
  | {
      kind: 'send';
      serialized: string;
      bytes: number;
      compacted: boolean;
      originalBytes: number;
    }
  | { kind: 'dropped'; originalBytes: number; reason: string };

/**
 * Serialization must never crash the send path: unserializable data (e.g. a
 * circular reference) degrades to the same compaction/drop ladder as an
 * oversized event.
 */
function tryStringify(event: IngestEvent): string | undefined {
  try {
    return JSON.stringify(event);
  } catch {
    return undefined;
  }
}

/**
 * Cheap lower-bound estimate of the JSON-serialized UTF-8 byte length of a
 * value. Walks the object tree summing string lengths and structural
 * overhead, short-circuiting as soon as the running total exceeds `budget`.
 *
 * This avoids calling `JSON.stringify` on oversized events (which blocks the
 * event loop for seconds on multi-MB payloads) just to discover they need
 * compaction. The estimate is a conservative lower bound — if it says
 * "under budget", the full serialization is attempted (which is fast for
 * genuinely small events). If it says "over budget", compaction runs
 * directly without ever materializing the full serialized string.
 *
 * Ancestor cycles (true circular references) are detected via a `WeakSet`
 * tracking the current path and skipped. Shared (non-cyclic) references are
 * counted at each occurrence, matching `JSON.stringify`.
 */
export function estimateSerializedBytes(value: unknown, budget: number): number {
  try {
    let total = 0;
    const stack: Array<{ v: unknown } | { exit: object }> = [{ v: value }];
    const path = new WeakSet<object>();
    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry === undefined) break;
      if ('exit' in entry) {
        path.delete(entry.exit);
        continue;
      }
      const item = entry.v;
      if (typeof item === 'string') {
        total += item.length + 2; // surrounding quotes
      } else if (typeof item === 'number') {
        total += 1; // lower bound (actual: 1–21 chars)
      } else if (typeof item === 'boolean') {
        total += 4; // "true" (4) or "false" (5)
      } else if (item === null) {
        total += 4; // "null"
      } else if (typeof item === 'object') {
        if (path.has(item)) continue; // ancestor cycle — skip
        path.add(item);
        stack.push({ exit: item }); // remove from path after children
        if (Array.isArray(item)) {
          total += 2; // brackets
          total += Math.max(0, item.length - 1); // commas
          if (total > budget) return total;
          for (let i = item.length - 1; i >= 0; i--) {
            stack.push({ v: item[i] });
          }
        } else {
          const keys = Object.keys(item);
          total += 2; // braces
          for (const key of keys) {
            total += key.length + 3; // "key":
          }
          total += Math.max(0, keys.length - 1); // commas
          if (total > budget) return total;
          for (let i = keys.length - 1; i >= 0; i--) {
            stack.push({ v: (item as Record<string, unknown>)[keys[i]] });
          }
        }
      }
      if (total > budget) return total;
    }
    return total;
  } catch {
    return budget + 1; // treat as oversized on error
  }
}

/**
 * Trim, serialize, measure, and (if needed) compact an ingest event so its
 * serialized UTF-8 byte length stays under `MAX_INGEST_EVENT_BYTES`.
 */
export function prepareIngestFrame(event: IngestEvent): PreparedIngestFrame {
  const trimmed: IngestEvent = {
    ...event,
    data: trimPayload(event.streamEventType, event.data),
  };

  // Pre-serialization estimate: if the event is clearly over budget, skip
  // the full JSON.stringify (which blocks the event loop for seconds on
  // multi-MB payloads) and go straight to compaction. The estimate is a
  // conservative lower bound, so events that pass are still measured
  // exactly via tryStringify below.
  const estimate = estimateSerializedBytes(trimmed, MAX_INGEST_EVENT_BYTES);

  let originalSerialized: string | undefined;
  let exactBytes: number | undefined;
  if (estimate <= MAX_INGEST_EVENT_BYTES) {
    originalSerialized = tryStringify(trimmed);
    if (originalSerialized !== undefined) {
      const originalBytes = byteLength(originalSerialized);
      if (originalBytes <= MAX_INGEST_EVENT_BYTES) {
        return {
          kind: 'send',
          serialized: originalSerialized,
          bytes: originalBytes,
          compacted: false,
          originalBytes,
        };
      }
      exactBytes = originalBytes;
    }
  }

  // Oversized or unserializable — compact without full serialization.
  // Prefer the exact measurement when serialization succeeded; otherwise
  // fall back to the estimate (a lower bound sufficient for observability).
  const originalBytes = exactBytes ?? estimate;

  const compactedEvent = compactIngestEvent(trimmed, originalBytes);
  const compactedSerialized = tryStringify(compactedEvent);
  if (compactedSerialized !== undefined) {
    const compactedBytes = byteLength(compactedSerialized);
    if (compactedBytes <= MAX_INGEST_EVENT_BYTES) {
      return {
        kind: 'send',
        serialized: compactedSerialized,
        bytes: compactedBytes,
        compacted: true,
        originalBytes,
      };
    }
  }

  const minimalEvent = minimalIngestEvent(trimmed, originalBytes);
  const minimalSerialized = tryStringify(minimalEvent);
  if (minimalSerialized !== undefined) {
    const minimalBytes = byteLength(minimalSerialized);
    if (minimalBytes <= MAX_INGEST_EVENT_BYTES) {
      return {
        kind: 'send',
        serialized: minimalSerialized,
        bytes: minimalBytes,
        compacted: true,
        originalBytes,
      };
    }
  }

  return {
    kind: 'dropped',
    originalBytes,
    reason:
      originalSerialized === undefined && estimate <= MAX_INGEST_EVENT_BYTES
        ? 'unserializable_ingest_event'
        : 'oversized_ingest_event',
  };
}

export type BufferedIngestFrame = {
  serialized: string;
  bytes: number;
  lifecycle: boolean;
};

/**
 * Disconnected-ingest buffer with a byte budget and a secondary count cap.
 *
 * Lifecycle/terminal frames are protected: when buffer pressure would force an
 * eviction, older non-lifecycle frames are dropped first. `isOverflowed` tracks
 * whether any frame was lost so the `wrapper_resumed` marker can report
 * `eventsLost`.
 */
export class IngestEventBuffer {
  private frames: BufferedIngestFrame[] = [];
  private totalBytes = 0;
  private overflowed = false;

  get length(): number {
    return this.frames.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get isOverflowed(): boolean {
    return this.overflowed;
  }

  /**
   * Push a prepared frame. Returns `true` when the frame was buffered.
   * Non-lifecycle frames that cannot fit (even after evicting older
   * non-lifecycle frames) are dropped and `false` is returned.
   */
  push(frame: BufferedIngestFrame): boolean {
    // Evict older non-lifecycle frames first to protect lifecycle signals.
    while (
      (this.totalBytes + frame.bytes > MAX_INGEST_BUFFERED_BYTES ||
        this.frames.length >= MAX_INGEST_BUFFER_COUNT) &&
      this.frames.some(f => !f.lifecycle)
    ) {
      const idx = this.frames.findIndex(f => !f.lifecycle);
      this.totalBytes -= this.frames[idx].bytes;
      this.frames.splice(idx, 1);
      this.overflowed = true;
    }

    if (
      this.totalBytes + frame.bytes <= MAX_INGEST_BUFFERED_BYTES &&
      this.frames.length < MAX_INGEST_BUFFER_COUNT
    ) {
      this.frames.push(frame);
      this.totalBytes += frame.bytes;
      return true;
    }

    if (!frame.lifecycle) {
      this.overflowed = true;
      return false;
    }

    // Buffer is saturated with lifecycle frames. Evict the oldest frames until
    // it fits so growth stays bounded; this loses an older terminal signal,
    // which is unavoidable when the buffer is saturated with lifecycle events.
    while (
      this.frames.length > 0 &&
      (this.totalBytes + frame.bytes > MAX_INGEST_BUFFERED_BYTES ||
        this.frames.length >= MAX_INGEST_BUFFER_COUNT)
    ) {
      const oldest = this.frames.shift();
      if (oldest) this.totalBytes -= oldest.bytes;
      this.overflowed = true;
    }
    this.frames.push(frame);
    this.totalBytes += frame.bytes;
    return true;
  }

  drain(): BufferedIngestFrame[] {
    const out = this.frames;
    this.frames = [];
    this.totalBytes = 0;
    this.overflowed = false;
    return out;
  }

  clear(): void {
    this.frames = [];
    this.totalBytes = 0;
    this.overflowed = false;
  }
}
