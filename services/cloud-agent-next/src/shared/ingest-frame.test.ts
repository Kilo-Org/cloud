import { describe, expect, it } from 'vitest';
import {
  MAX_INGEST_BUFFERED_BYTES,
  MAX_INGEST_EVENT_BYTES,
  IngestEventBuffer,
  estimateSerializedBytes,
  isLifecycleIngestEvent,
  prepareIngestFrame,
} from './ingest-frame.js';
import type { IngestEvent } from './protocol.js';

describe('prepareIngestFrame', () => {
  it('passes small events through unchanged', () => {
    const event: IngestEvent = {
      streamEventType: 'kilocode',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: { event: 'session.status', type: 'session.status', properties: { type: 'idle' } },
    };
    const frame = prepareIngestFrame(event);
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(false);
    expect(frame.bytes).toBeLessThanOrEqual(MAX_INGEST_EVENT_BYTES);
  });

  it('applies payload trimming to file parts before serialization', () => {
    const rawDataUrl = 'data:image/png;base64,wrapper-private-image';
    const rawSourceText = 'wrapper private source text';

    const frame = prepareIngestFrame({
      streamEventType: 'kilocode',
      data: {
        event: 'message.part.updated',
        type: 'message.part.updated',
        part: {
          type: 'file',
          url: rawDataUrl,
          source: { text: { value: rawSourceText } },
        },
      },
      timestamp: '2026-04-14T08:00:00.000Z',
    });

    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.serialized).not.toContain(rawDataUrl);
    expect(frame.serialized).not.toContain(rawSourceText);
  });

  it('truncates oversized output before send via the single serialization path', () => {
    const event: IngestEvent = {
      streamEventType: 'output',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: { content: 'x'.repeat(2_000_000), source: 'stdout' },
    };
    const frame = prepareIngestFrame(event);
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.bytes).toBeLessThanOrEqual(MAX_INGEST_EVENT_BYTES);
    const sent = JSON.parse(frame.serialized);
    expect((sent.data.content as string).length).toBeLessThan(20_000);
  });

  it('compacts oversized message.part.updated tool output under the byte budget', () => {
    const event: IngestEvent = {
      streamEventType: 'kilocode',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: {
        event: 'message.part.updated',
        type: 'message.part.updated',
        properties: {
          sessionID: 'sess_1',
          part: {
            type: 'tool',
            id: 'part_1',
            messageID: 'msg_1',
            state: {
              status: 'completed',
              output: 'x'.repeat(50_000),
              customDiagnostics: 'y'.repeat(2_000_000),
            },
          },
        },
        part: {
          type: 'tool',
          id: 'part_1',
          messageID: 'msg_1',
          state: { status: 'completed', output: 'x'.repeat(50_000) },
        },
      },
    };
    const frame = prepareIngestFrame(event);
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(true);
    expect(frame.bytes).toBeLessThanOrEqual(MAX_INGEST_EVENT_BYTES);
    expect(frame.serialized).not.toContain('yyyyy');
    const sent = JSON.parse(frame.serialized);
    expect(sent.streamEventType).toBe('kilocode');
    const part = sent.data.properties.part;
    expect(part.id).toBe('part_1');
    expect(part.messageID).toBe('msg_1');
    expect(part.state.status).toBe('completed');
  });

  it('reduces oversized message.updated to a metadata-only event', () => {
    const event: IngestEvent = {
      streamEventType: 'kilocode',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: {
        event: 'message.updated',
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            parentID: 'msg_0',
            sessionID: 'sess_1',
            role: 'assistant',
            time: { started: 1, completed: 2 },
            parts: [{ type: 'text', text: 'z'.repeat(2_000_000) }],
          },
        },
      },
    };
    const frame = prepareIngestFrame(event);
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(true);
    expect(frame.bytes).toBeLessThanOrEqual(MAX_INGEST_EVENT_BYTES);
    expect(frame.serialized).not.toContain('zzzzz');
    const sent = JSON.parse(frame.serialized);
    const info = sent.data.properties.info;
    expect(info.id).toBe('msg_1');
    expect(info.parentID).toBe('msg_0');
    expect(info.role).toBe('assistant');
    expect(info.parts).toBeUndefined();
  });

  it('still sends a compact fatal event for a terminal error with huge diagnostics', () => {
    const event: IngestEvent = {
      streamEventType: 'error',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: {
        fatal: true,
        errorSource: 'assistant',
        error: 'Provider failed: ' + 'z'.repeat(2_000_000),
        failureCode: 'payment_required',
        modelNotFoundRuntimeDiagnostics: { availableModels: 'q'.repeat(2_000_000).split('') },
      },
    };
    const frame = prepareIngestFrame(event);
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(true);
    expect(frame.bytes).toBeLessThanOrEqual(MAX_INGEST_EVENT_BYTES);
    // Heavy diagnostics are dropped; a safe truncated error text is preserved.
    expect(frame.serialized).not.toContain('qqqqq');
    const sent = JSON.parse(frame.serialized);
    expect(sent.streamEventType).toBe('error');
    expect(sent.data.fatal).toBe(true);
    expect(sent.data.errorSource).toBe('assistant');
    expect(sent.data.failureCode).toBe('payment_required');
    expect((sent.data.error as string).length).toBeLessThan(20_000);
    expect(sent.data.modelNotFoundRuntimeDiagnostics).toBeUndefined();
  });

  it('replaces a generic oversized non-terminal event with a wrapper_event_truncated surrogate', () => {
    const event: IngestEvent = {
      streamEventType: 'status',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: { message: 'z'.repeat(2_000_000) },
    };
    const frame = prepareIngestFrame(event);
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(true);
    expect(frame.bytes).toBeLessThanOrEqual(MAX_INGEST_EVENT_BYTES);
    const sent = JSON.parse(frame.serialized);
    expect(sent.streamEventType).toBe('wrapper_event_truncated');
    expect(sent.data.originalStreamEventType).toBe('status');
    expect(sent.data.reason).toBe('oversized_ingest_event');
    expect(sent.data.originalBytes).toBeGreaterThan(MAX_INGEST_EVENT_BYTES);
  });

  it('degrades an unserializable non-terminal event to a surrogate instead of throwing', () => {
    const circular: Record<string, unknown> = { message: 'boom' };
    circular.self = circular;
    const frame = prepareIngestFrame({
      streamEventType: 'status',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: circular,
    });
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(true);
    const sent = JSON.parse(frame.serialized);
    expect(sent.streamEventType).toBe('wrapper_event_truncated');
    expect(sent.data.originalStreamEventType).toBe('status');
  });

  it('still sends a compact terminal error when its data is unserializable', () => {
    const circular: Record<string, unknown> = { fatal: true, error: 'boom' };
    circular.self = circular;
    const frame = prepareIngestFrame({
      streamEventType: 'error',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: circular,
    });
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(true);
    const sent = JSON.parse(frame.serialized);
    expect(sent.streamEventType).toBe('error');
    expect(sent.data.fatal).toBe(true);
    expect(sent.data.error).toBe('boom');
  });

  it('falls back to the minimal form when even the compacted event is unserializable', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // compactMessagePartUpdated copies `type` verbatim, so the compacted event
    // is still circular and only the minimal surrogate can be serialized.
    const frame = prepareIngestFrame({
      streamEventType: 'kilocode',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: { event: 'message.part.updated', type: circular },
    });
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(true);
    const sent = JSON.parse(frame.serialized);
    expect(sent.streamEventType).toBe('wrapper_event_truncated');
    expect(sent.data.kiloEventName).toBe('message.part.updated');
  });

  it('compacts a very large message.updated without serializing the full payload', () => {
    // A 10 MB event would block the event loop for seconds if JSON.stringify
    // were called on the full payload. The estimate must short-circuit and
    // route directly to compaction.
    const event: IngestEvent = {
      streamEventType: 'kilocode',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: {
        event: 'message.updated',
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_big',
            sessionID: 'sess_1',
            role: 'assistant',
            time: { started: 1, completed: 2 },
            parts: [{ type: 'text', text: 'z'.repeat(10_000_000) }],
          },
        },
      },
    };
    const frame = prepareIngestFrame(event);
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') return;
    expect(frame.compacted).toBe(true);
    expect(frame.bytes).toBeLessThanOrEqual(MAX_INGEST_EVENT_BYTES);
    // The huge text must not appear in the compacted output.
    expect(frame.serialized).not.toContain('zzzzz');
    const sent = JSON.parse(frame.serialized);
    expect(sent.data.properties.info.id).toBe('msg_big');
    expect(sent.data.properties.info.parts).toBeUndefined();
    // originalBytes reflects the estimate (a lower bound), still over budget.
    expect(frame.originalBytes).toBeGreaterThan(MAX_INGEST_EVENT_BYTES);
  });

  it('preserves the exact byte count when the estimate is under budget but serialization exceeds it', () => {
    // Each emoji is 2 UTF-16 code units but 4 UTF-8 bytes. A string of 400K
    // emoji has .length = 800K (under the 1 MiB estimate budget) but UTF-8
    // byte length ≈ 1.6 MB (over the send budget). The estimate passes, so
    // tryStringify runs and produces an over-budget result — originalBytes
    // must reflect the exact measurement, not the lower estimate.
    const event: IngestEvent = {
      streamEventType: 'status',
      timestamp: '2026-04-14T08:00:00.000Z',
      data: { message: '😀'.repeat(400_000) },
    };
    const frame = prepareIngestFrame(event);
    expect(frame.originalBytes).toBeGreaterThan(MAX_INGEST_EVENT_BYTES);
    if (frame.kind === 'send') {
      expect(frame.compacted).toBe(true);
    }
  });
});

describe('estimateSerializedBytes', () => {
  it('returns a lower bound on the actual serialized size', () => {
    const value = { a: 'hello', b: 42, c: true, d: null, e: [1, 2, 3] };
    const actual = JSON.stringify(value).length;
    const estimate = estimateSerializedBytes(value, 1_000_000);
    expect(estimate).toBeLessThanOrEqual(actual);
    expect(estimate).toBeGreaterThan(0);
  });

  it('short-circuits when the estimate exceeds the budget', () => {
    const value = { big: 'x'.repeat(2_000_000) };
    const estimate = estimateSerializedBytes(value, 1_000_000);
    expect(estimate).toBeGreaterThan(1_000_000);
    // Should not walk the entire object — just enough to exceed the budget.
    expect(estimate).toBeLessThan(2_100_000);
  });

  it('handles circular references without infinite looping', () => {
    const circular: Record<string, unknown> = { a: 'hello' };
    circular.self = circular;
    const estimate = estimateSerializedBytes(circular, 1_000_000);
    expect(estimate).toBeLessThan(100);
  });

  it('counts shared (non-cyclic) references at each occurrence', () => {
    // A shared sub-object referenced from two keys must be counted twice,
    // matching JSON.stringify (which serializes it at each occurrence).
    const shared = { text: 'x'.repeat(100_000) };
    const value = { a: shared, b: shared };
    const actual = JSON.stringify(value).length;
    const estimate = estimateSerializedBytes(value, 1_000_000);
    expect(estimate).toBeLessThanOrEqual(actual);
    // Counting shared only once would underestimate by ~100K bytes.
    expect(estimate).toBeGreaterThan(200_000);
  });

  it('short-circuits on wide arrays via structural overhead', () => {
    // 2M-element sparse array: comma overhead (2M-1) alone exceeds the 1M
    // budget, so the estimate returns without queuing or walking elements.
    const value = { arr: new Array(2_000_000) };
    const estimate = estimateSerializedBytes(value, 1_000_000);
    expect(estimate).toBeGreaterThan(1_000_000);
    expect(estimate).toBeLessThan(2_010_000);
  });

  it('returns 2 for an empty object', () => {
    expect(estimateSerializedBytes({}, 1_000_000)).toBe(2);
  });

  it('returns 2 for an empty array', () => {
    expect(estimateSerializedBytes([], 1_000_000)).toBe(2);
  });

  it('treats errors as oversized so compaction is used', () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, 'throwingGetter', {
      get: () => {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const estimate = estimateSerializedBytes(obj, 1_000_000);
    expect(estimate).toBeGreaterThan(1_000_000);
  });
});

describe('IngestEventBuffer', () => {
  it('drops non-lifecycle events under byte pressure and marks eventsLost', () => {
    const buffer = new IngestEventBuffer();
    const big = 2_000_000;
    expect(buffer.push({ serialized: 'a', bytes: big, lifecycle: false })).toBe(true);
    expect(buffer.push({ serialized: 'b', bytes: big, lifecycle: false })).toBe(true);
    // Third non-lifecycle frame does not fit; oldest non-lifecycle is evicted.
    expect(buffer.push({ serialized: 'c', bytes: big, lifecycle: false })).toBe(true);

    expect(buffer.isOverflowed).toBe(true);
    expect(buffer.bytes).toBeLessThanOrEqual(MAX_INGEST_BUFFERED_BYTES);
    expect(buffer.length).toBe(2);
    const drained = buffer.drain();
    expect(drained.map(f => f.serialized)).toEqual(['b', 'c']);
    expect(buffer.isOverflowed).toBe(false);
  });

  it('prioritizes lifecycle events by evicting non-lifecycle frames to make room', () => {
    const buffer = new IngestEventBuffer();
    expect(buffer.push({ serialized: 'a', bytes: 2_000_000, lifecycle: false })).toBe(true);
    expect(buffer.push({ serialized: 'b', bytes: 2_000_000, lifecycle: false })).toBe(true);
    // Buffer is at the byte budget; lifecycle frame must still be accepted.
    const accepted = buffer.push({ serialized: 'L', bytes: 1_000_000, lifecycle: true });
    expect(accepted).toBe(true);
    expect(buffer.isOverflowed).toBe(true);
    const drained = buffer.drain();
    expect(drained.some(f => f.serialized === 'L')).toBe(true);
    expect(drained.some(f => f.serialized === 'a')).toBe(false);
  });

  it('drops a non-lifecycle frame instead of evicting lifecycle frames', () => {
    const buffer = new IngestEventBuffer();
    expect(buffer.push({ serialized: 'L1', bytes: 2_000_000, lifecycle: true })).toBe(true);
    expect(buffer.push({ serialized: 'L2', bytes: 2_000_000, lifecycle: true })).toBe(true);
    // Buffer full of lifecycle frames: a non-lifecycle frame is dropped.
    const accepted = buffer.push({ serialized: 'N', bytes: 1_000_000, lifecycle: false });
    expect(accepted).toBe(false);
    expect(buffer.isOverflowed).toBe(true);
    expect(buffer.length).toBe(2);
    const drained = buffer.drain();
    expect(drained.map(f => f.serialized)).toEqual(['L1', 'L2']);
  });

  it('classifies terminal stream event types as lifecycle', () => {
    for (const streamEventType of [
      'complete',
      'interrupted',
      'error',
      'cloud.message.completed',
      'wrapper_finalizing',
      'autocommit_started',
      'autocommit_completed',
    ] as const) {
      expect(
        isLifecycleIngestEvent({
          streamEventType,
          timestamp: '2026-04-14T08:00:00.000Z',
          data: {},
        })
      ).toBe(true);
    }
    expect(
      isLifecycleIngestEvent({
        streamEventType: 'kilocode',
        timestamp: '2026-04-14T08:00:00.000Z',
        data: {},
      })
    ).toBe(false);
  });
});
