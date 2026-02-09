import { describe, it, expect, vi } from 'vitest';
import { createStreamHandler, formatStreamEvent } from './stream.js';
import type { StoredEvent, StreamFilters } from './types.js';
import type { SessionId, EventId } from '../types/ids.js';
import type { EventQueries, EventQueryFilters } from '../session/queries/index.js';

const SESSION_ID = 'sess_test' as SessionId;

function makeEvent(id: number, payload = '{}'): StoredEvent {
  return {
    id: id,
    execution_id: 'exec_1',
    session_id: SESSION_ID,
    stream_event_type: 'output',
    payload,
    timestamp: 1000 + id,
  };
}

/**
 * Build a payload string of approximately `bytes` length.
 * The exact serialized size will be slightly larger due to the
 * event envelope added by formatStreamEvent + JSON.stringify.
 */
function makePayload(bytes: number): string {
  return JSON.stringify({ text: 'x'.repeat(bytes) });
}

function makeFakeEventQueries(events: StoredEvent[]): EventQueries {
  return {
    *iterateByFilters({ fromId }: Omit<EventQueryFilters, 'limit'>) {
      for (const e of events) {
        if (fromId !== undefined && e.id <= fromId) continue;
        yield e;
      }
    },
    findByFilters({ fromId, limit }: EventQueryFilters) {
      let filtered = events;
      if (fromId !== undefined) {
        filtered = filtered.filter(e => e.id > fromId);
      }
      if (limit !== undefined) {
        filtered = filtered.slice(0, limit);
      }
      return filtered;
    },
    insert: vi.fn(),
    deleteOlderThan: vi.fn(),
    countByExecutionId: vi.fn(),
    getLatestEventId: vi.fn(),
  } as unknown as EventQueries;
}

function makeFakeState(): DurableObjectState {
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn(() => []),
  } as unknown as DurableObjectState;
}

function makeFakeWebSocket(): WebSocket & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    sentMessages,
    send(data: string) {
      sentMessages.push(data);
    },
    close: vi.fn(),
  } as unknown as WebSocket & { sentMessages: string[] };
}

describe('stream handler replayEvents', () => {
  it('sends all events when total size is within byte budget', async () => {
    const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
    const eq = makeFakeEventQueries(events);
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID);
    const ws = makeFakeWebSocket();

    const filters: StreamFilters = { sessionId: SESSION_ID };
    await handler.replayEvents(ws, filters);

    expect(ws.sentMessages).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const parsed = JSON.parse(ws.sentMessages[i]);
      expect(parsed.eventId).toBe(i + 1);
    }
  });

  it('splits into multiple rounds when payloads exceed byte budget', async () => {
    // Each event is ~200KB of payload; byte budget is 1MiB.
    // 6 events × 200KB = 1.2MB total → should need at least 2 rounds.
    const events = Array.from({ length: 6 }, (_, i) => makeEvent(i + 1, makePayload(200_000)));
    const eq = makeFakeEventQueries(events);
    const iterateSpy = vi.spyOn(eq, 'iterateByFilters');
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID);
    const ws = makeFakeWebSocket();

    const filters: StreamFilters = { sessionId: SESSION_ID };
    await handler.replayEvents(ws, filters);

    // All 6 events should be sent
    expect(ws.sentMessages).toHaveLength(6);

    // Should have started multiple rounds (the generator was called more than once)
    expect(iterateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Second round should have a cursor set from the first round
    expect(iterateSpy.mock.calls[1][0].fromId).toBeGreaterThan(0);
  });

  it('respects the fromId filter from the client', async () => {
    const events = Array.from({ length: 10 }, (_, i) => makeEvent(i + 1));
    const eq = makeFakeEventQueries(events);
    const iterateSpy = vi.spyOn(eq, 'iterateByFilters');
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID);
    const ws = makeFakeWebSocket();

    const filters: StreamFilters = { sessionId: SESSION_ID, fromId: 5 as EventId };
    await handler.replayEvents(ws, filters);

    // Events 6-10
    expect(ws.sentMessages).toHaveLength(5);

    // First call should use the client-provided fromId
    expect(iterateSpy.mock.calls[0][0].fromId).toBe(5);
  });

  it('handles zero events gracefully', async () => {
    const eq = makeFakeEventQueries([]);
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID);
    const ws = makeFakeWebSocket();

    const filters: StreamFilters = { sessionId: SESSION_ID };
    await handler.replayEvents(ws, filters);

    expect(ws.sentMessages).toHaveLength(0);
  });

  it('sends at least one event per round even if it exceeds the byte budget', async () => {
    // Single event with a payload larger than the 1MiB byte budget
    const events = [makeEvent(1, makePayload(2_000_000))];
    const eq = makeFakeEventQueries(events);
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID);
    const ws = makeFakeWebSocket();

    const filters: StreamFilters = { sessionId: SESSION_ID };
    await handler.replayEvents(ws, filters);

    expect(ws.sentMessages).toHaveLength(1);
    const parsed = JSON.parse(ws.sentMessages[0]);
    expect(parsed.eventId).toBe(1);
  });

  it('sends an error message on query failure', async () => {
    const eq = makeFakeEventQueries([]);
    // eslint-disable-next-line require-yield
    vi.spyOn(eq, 'iterateByFilters').mockImplementation(function* () {
      throw new Error('SQLite error');
    });
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID);
    const ws = makeFakeWebSocket();

    const filters: StreamFilters = { sessionId: SESSION_ID };
    await handler.replayEvents(ws, filters);

    expect(ws.sentMessages).toHaveLength(1);
    const parsed = JSON.parse(ws.sentMessages[0]);
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('WS_INTERNAL_ERROR');
  });

  it('abandons the cursor mid-iteration when byte budget is exceeded', async () => {
    // 10 events, each ~300KB. Budget is 1MiB ≈ 3-4 events per round.
    const events = Array.from({ length: 10 }, (_, i) => makeEvent(i + 1, makePayload(300_000)));
    const eq = makeFakeEventQueries(events);
    const iterateSpy = vi.spyOn(eq, 'iterateByFilters');
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID);
    const ws = makeFakeWebSocket();

    const filters: StreamFilters = { sessionId: SESSION_ID };
    await handler.replayEvents(ws, filters);

    // All events should still be delivered across multiple rounds
    expect(ws.sentMessages).toHaveLength(10);

    // Multiple rounds needed
    const rounds = iterateSpy.mock.calls.length;
    expect(rounds).toBeGreaterThanOrEqual(3);

    // Each subsequent round should pick up where the previous left off
    for (let i = 1; i < rounds; i++) {
      const prevFromId = iterateSpy.mock.calls[i][0].fromId;
      expect(prevFromId).toBeDefined();
      expect(prevFromId).toBeGreaterThan(0);
    }
  });
});

describe('formatStreamEvent', () => {
  it('parses payload JSON and formats the event', () => {
    const event = makeEvent(42, JSON.stringify({ text: 'hello' }));
    const formatted = formatStreamEvent(event, SESSION_ID);

    expect(formatted.eventId).toBe(42);
    expect(formatted.sessionId).toBe(SESSION_ID);
    expect(formatted.streamEventType).toBe('output');
    expect(formatted.data).toEqual({ text: 'hello' });
    expect(formatted.timestamp).toBe(new Date(1042).toISOString());
  });
});
