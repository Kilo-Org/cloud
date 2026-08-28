import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createStreamHandler, formatStreamEvent } from './stream.js';
import type { StoredEvent, StreamFilters } from './types.js';
import type { SessionId, EventId } from '../types/ids.js';
import type { EventQueries, EventQueryFilters } from '../session/queries/index.js';
import { DEFAULT_SLASH_COMMANDS } from '../shared/default-slash-commands.generated';
import { normalize, isChatEvent } from '../../../../packages/cloud-agent-sdk/src/normalizer';
import { createServiceState } from '../../../../packages/cloud-agent-sdk/src/service-state';

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
    *iterateByFilters(filters: Omit<EventQueryFilters, 'limit'>) {
      for (const e of events) {
        if (filters.fromId !== undefined && e.id <= filters.fromId) continue;
        if (filters.eventTypes?.length && !filters.eventTypes.includes(e.stream_event_type))
          continue;
        if (filters.executionIds?.length && !filters.executionIds.includes(e.execution_id))
          continue;
        if (filters.startTime !== undefined && e.timestamp < filters.startTime) continue;
        if (filters.endTime !== undefined && e.timestamp > filters.endTime) continue;
        if (filters.materialized) {
          if (e.stream_event_type !== 'kilocode') continue;
          const payload = JSON.parse(e.payload) as { event?: string };
          const names =
            filters.materialized === 'updates'
              ? ['message.updated', 'message.part.updated', 'autocommit_completed']
              : ['message.removed', 'message.part.removed'];
          if (!payload.event || !names.includes(payload.event)) continue;
        }
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

function makeKiloEvent(
  id: number,
  event: string,
  properties: Record<string, unknown>
): StoredEvent {
  return {
    ...makeEvent(id, JSON.stringify({ event, type: event, properties })),
    stream_event_type: 'kilocode',
  };
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
    serializeAttachment: vi.fn(),
  } as unknown as WebSocket & { sentMessages: string[] };
}

function processSdkFrame(
  state: ReturnType<typeof createServiceState>,
  frame: ReturnType<typeof formatStreamEvent>
): void {
  const event = normalize(frame);
  expect(event).not.toBeNull();
  if (event && !isChatEvent(event)) state.process(event);
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
      const parsed = JSON.parse(ws.sentMessages[i]) as Record<string, unknown>;
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
    const parsed = JSON.parse(ws.sentMessages[0]) as Record<string, unknown>;
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
    const parsed = JSON.parse(ws.sentMessages[0]) as Record<string, unknown>;
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

describe('stream handler handleStreamRequest', () => {
  const OriginalResponse = Response;

  beforeAll(() => {
    vi.stubGlobal(
      'Response',
      vi.fn(function Response(body?: BodyInit | null, init?: ResponseInit) {
        if (init && init.status === 101) {
          const r = new OriginalResponse(body, { ...init, status: 200 });
          (r as unknown as Record<string, unknown>).webSocket = init.webSocket;
          return r;
        }
        return new OriginalResponse(body, init);
      })
    );
  });

  afterAll(() => {
    vi.stubGlobal('Response', OriginalResponse);
  });

  function mockWebSocketPair(serverWs: WebSocket): void {
    // @ts-expect-error WebSocketPair is a Workers runtime global
    globalThis.WebSocketPair = vi.fn(function WebSocketPair() {
      return [{}, serverWs];
    });
  }

  it('sends bare preparing cloud status in the synthetic connected event', async () => {
    const serverWs = makeFakeWebSocket();
    mockWebSocketPair(serverWs);

    const eq = makeFakeEventQueries([]);
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID, {
      deriveCloudStatus: async () => ({ type: 'preparing' }),
    });

    const request = new Request('https://example.com/stream', {
      headers: { Upgrade: 'websocket' },
    });
    await handler.handleStreamRequest(request);

    const connectedMessage = serverWs.sentMessages.find(m => {
      const parsed = JSON.parse(m) as Record<string, unknown>;
      return parsed.streamEventType === 'connected';
    });
    expect(connectedMessage).toBeDefined();
    const parsed = JSON.parse(connectedMessage!) as Record<string, unknown>;
    expect(parsed.data).toEqual({ cloudStatus: { type: 'preparing' } });
  });

  it('sends cached commands.available on connect when no eventTypes filter is set', async () => {
    const serverWs = makeFakeWebSocket();
    mockWebSocketPair(serverWs);

    const eq = makeFakeEventQueries([]);
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID, {
      getAvailableCommands: async () => [{ name: 'review', description: 'Review code', hints: [] }],
    });

    const request = new Request('https://example.com/stream', {
      headers: { Upgrade: 'websocket' },
    });
    await handler.handleStreamRequest(request);

    const catalogMessage = serverWs.sentMessages.find(m => {
      const parsed = JSON.parse(m) as Record<string, unknown>;
      return parsed.streamEventType === 'commands.available';
    });
    expect(catalogMessage).toBeDefined();
    const parsed = JSON.parse(catalogMessage!) as Record<string, unknown>;
    expect((parsed.data as Record<string, unknown>).commands).toEqual([
      { name: 'review', description: 'Review code', hints: [] },
    ]);
  });

  it('skips commands.available on connect when eventTypes excludes it', async () => {
    const serverWs = makeFakeWebSocket();
    mockWebSocketPair(serverWs);

    const eq = makeFakeEventQueries([]);
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID, {
      getAvailableCommands: async () => [{ name: 'review', description: 'Review code', hints: [] }],
    });

    const request = new Request('https://example.com/stream?eventTypes=output', {
      headers: { Upgrade: 'websocket' },
    });
    await handler.handleStreamRequest(request);

    const catalogMessage = serverWs.sentMessages.find(m => {
      const parsed = JSON.parse(m) as Record<string, unknown>;
      return parsed.streamEventType === 'commands.available';
    });
    expect(catalogMessage).toBeUndefined();
  });

  it('sends commands.available on connect when eventTypes explicitly includes it', async () => {
    const serverWs = makeFakeWebSocket();
    mockWebSocketPair(serverWs);

    const eq = makeFakeEventQueries([]);
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID, {
      getAvailableCommands: async () => [{ name: 'review', description: 'Review code', hints: [] }],
    });

    const request = new Request('https://example.com/stream?eventTypes=output,commands.available', {
      headers: { Upgrade: 'websocket' },
    });
    await handler.handleStreamRequest(request);

    const catalogMessage = serverWs.sentMessages.find(m => {
      const parsed = JSON.parse(m) as Record<string, unknown>;
      return parsed.streamEventType === 'commands.available';
    });
    expect(catalogMessage).toBeDefined();
  });

  it('emits default commands when getAvailableCommands returns defaults', async () => {
    const serverWs = makeFakeWebSocket();
    mockWebSocketPair(serverWs);

    const eq = makeFakeEventQueries([]);
    const handler = createStreamHandler(makeFakeState(), eq, SESSION_ID, {
      getAvailableCommands: async () => DEFAULT_SLASH_COMMANDS,
    });

    const request = new Request('https://example.com/stream', {
      headers: { Upgrade: 'websocket' },
    });
    await handler.handleStreamRequest(request);

    const catalogMessage = serverWs.sentMessages.find(m => {
      const parsed = JSON.parse(m) as Record<string, unknown>;
      return parsed.streamEventType === 'commands.available';
    });
    expect(catalogMessage).toBeDefined();
    const parsed = JSON.parse(catalogMessage!) as Record<string, unknown>;
    expect((parsed.data as Record<string, unknown>).commands).toEqual(DEFAULT_SLASH_COMMANDS);
  });

  it('preserves legacy rebuild preparation over historical readiness on reconnect', async () => {
    const serverWs = makeFakeWebSocket();
    mockWebSocketPair(serverWs);
    const state = createServiceState({ rootSessionId: 'ses_root' });
    const handler = createStreamHandler(makeFakeState(), makeFakeEventQueries([]), SESSION_ID, {
      deriveCloudStatus: async () => ({ type: 'ready' }),
      deriveQueuedMessages: async () => [
        { messageId: 'rebuild-message', content: 'Resume work', timestamp: 1000 },
      ],
      getPreparationSnapshots: async () => [
        {
          ...makeEvent(
            10,
            JSON.stringify({
              version: 2,
              attemptId: 'prepare-rebuild',
              triggerMessageId: 'rebuild-message',
              revision: 1,
              timestamp: 2000,
              step: 'workspace_restore',
              message: 'Restoring workspace',
              action: 'attempt_snapshot',
              attempt: {
                id: 'prepare-rebuild',
                triggerMessageId: 'rebuild-message',
                status: 'running',
                startedAt: 2000,
                revision: 1,
              },
            })
          ),
          stream_event_type: 'preparing',
        },
      ],
    });

    await handler.handleStreamRequest(
      new Request('https://example.com/stream?replay=false', {
        headers: { Upgrade: 'websocket' },
      })
    );

    for (const message of serverWs.sentMessages) processSdkFrame(state, JSON.parse(message));
    expect(state.getCloudStatus()).toMatchObject({ type: 'preparing' });
    expect(state.getPreparationAttempts()).toEqual([
      expect.objectContaining({ id: 'prepare-rebuild', status: 'running' }),
    ]);
    expect(state.getPendingMessages().get('rebuild-message')).toEqual({ status: 'queued' });
  });

  it.each([
    { client: 'fresh', completedPreparation: false },
    { client: 'stale queued A', completedPreparation: false },
    { client: 'fresh', completedPreparation: true },
    { client: 'stale queued A', completedPreparation: true },
  ])(
    'keeps B queued and preparing after A history for $client, completedPreparation=$completedPreparation',
    async ({ client, completedPreparation }) => {
      const state = createServiceState({ rootSessionId: 'ses_root' });
      if (client === 'stale queued A') {
        state.process({ type: 'cloud.message.queued', messageId: 'A' });
        state.process({ type: 'cloud.status', cloudStatus: { type: 'preparing' } });
        state.process({ type: 'stopped', reason: 'transport-disconnected' });
        expect(state.getPendingMessages().get('A')).toEqual({ status: 'queued' });
      }
      const preparationSnapshot: StoredEvent = {
        ...makeEvent(
          10,
          JSON.stringify({
            version: 2,
            attemptId: 'prepare-A',
            triggerMessageId: 'A',
            revision: 5,
            timestamp: 2000,
            step: 'workspace_setup',
            message: 'Preparation snapshot',
            action: 'attempt_snapshot',
            attempt: {
              id: 'prepare-A',
              triggerMessageId: 'A',
              status: 'completed',
              startedAt: 1000,
              completedAt: 2000,
              revision: 5,
            },
          })
        ),
        stream_event_type: 'preparing',
        timestamp: 2000,
      };
      const serverWs = makeFakeWebSocket();
      mockWebSocketPair(serverWs);
      const handler = createStreamHandler(makeFakeState(), makeFakeEventQueries([]), SESSION_ID, {
        reconcileMaterializedEvents: true,
        getPreparationSnapshots: async () => (completedPreparation ? [preparationSnapshot] : []),
        deriveCloudStatus: async () => ({ type: 'preparing' }),
        deriveSessionStatus: async () => ({ type: 'idle' }),
        derivePendingInteractions: async () => ({ questions: [], permissions: [] }),
        deriveQueuedMessages: async () => [
          {
            messageId: 'A',
            content: 'Old prompt',
            timestamp: 1000,
            terminalFailure: {
              messageId: 'A',
              status: 'failed',
              delivery: 'queued',
              accepted: false,
              reason: 'execution',
              error: 'A delivery failed',
              timestamp: 2000,
            },
          },
          { messageId: 'B', content: 'Recovery', timestamp: 3000 },
        ],
      });

      await handler.handleStreamRequest(
        new Request('https://example.com/stream?replay=false', {
          headers: { Upgrade: 'websocket' },
        })
      );

      const frames = serverWs.sentMessages.map(message => JSON.parse(message));
      for (const frame of frames) processSdkFrame(state, frame);
      expect(frames.at(-2)).toMatchObject({
        eventId: 0,
        streamEventType: 'connected',
        data: { activeMessageId: null, cloudStatus: { type: 'preparing' } },
      });
      expect(frames.at(-1)).toMatchObject({
        streamEventType: 'cloud.message.queued',
        data: { messageId: 'B' },
      });
      expect(state.getCloudStatus()).toEqual({ type: 'preparing' });
      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(state.getStatus()).toEqual({ type: 'idle' });
      expect(state.getPreparationAttempts().map(attempt => attempt.status)).toEqual(
        completedPreparation ? ['completed'] : []
      );
      expect.soft(new Map(state.getPendingMessages())).toEqual(
        new Map([
          ['B', { status: 'queued' }],
          ['A', { status: 'failed', error: 'A delivery failed', reason: 'execution' }],
        ])
      );

      processSdkFrame(
        state,
        formatStreamEvent(
          {
            ...makeEvent(
              21,
              JSON.stringify({
                messageId: 'B',
                delivery: 'queued',
                accepted: false,
                error: 'B preparation failed',
              })
            ),
            stream_event_type: 'cloud.message.failed',
          },
          SESSION_ID
        )
      );
      expect(state.getCloudStatus()).toEqual({ type: 'error', message: 'B preparation failed' });
      expect(state.getActivity()).toEqual({ type: 'idle' });
      expect(state.getPendingMessages().get('B')).toMatchObject({
        status: 'failed',
        error: 'B preparation failed',
      });
    }
  );

  it('projects accepted work and pending child interactions after historical failures', async () => {
    const serverWs = makeFakeWebSocket();
    mockWebSocketPair(serverWs);
    const state = createServiceState({ rootSessionId: 'ses_root' });
    const pendingInteractions = {
      questions: [
        {
          id: 'question-child',
          sessionID: 'ses_child',
          questions: [{ question: 'Continue?', header: 'Approval', options: [] }],
        },
      ],
      permissions: [],
    };
    const handler = createStreamHandler(makeFakeState(), makeFakeEventQueries([]), SESSION_ID, {
      reconcileMaterializedEvents: true,
      deriveCloudStatus: async () => ({ type: 'ready' }),
      deriveSessionStatus: async () => ({ type: 'busy' }),
      derivePendingInteractions: async () => pendingInteractions,
      deriveQueuedMessages: async () => [
        {
          messageId: 'old',
          content: 'Old prompt',
          timestamp: 1000,
          terminalFailure: {
            messageId: 'old',
            status: 'failed',
            delivery: 'sent',
            accepted: true,
            error: 'Execution failed',
            reason: 'execution',
            timestamp: 2000,
          },
        },
        { messageId: 'current', content: 'Current prompt', timestamp: 3000, delivery: 'sent' },
      ],
    });

    await handler.handleStreamRequest(
      new Request('https://example.com/stream?fromId=20', {
        headers: { Upgrade: 'websocket' },
      })
    );

    const frames = serverWs.sentMessages.map(message => JSON.parse(message));
    expect(frames.find(frame => frame.streamEventType === 'connected')?.data).toEqual({
      cloudStatus: { type: 'ready' },
      sessionStatus: { type: 'busy' },
      activeMessageId: 'current',
      pendingInteractions,
    });
    const sentIndex = frames.findIndex(frame => frame.streamEventType === 'cloud.message.sent');
    const failureIndex = frames.findIndex(
      frame => frame.streamEventType === 'cloud.message.failed'
    );
    const connectedIndex = frames.findIndex(frame => frame.streamEventType === 'connected');
    expect(failureIndex).toBeGreaterThan(-1);
    expect(failureIndex).toBeLessThan(connectedIndex);
    expect(connectedIndex).toBeLessThan(sentIndex);
    expect(frames[sentIndex].data).toEqual({ messageId: 'current', delivery: 'sent' });
    expect(
      frames
        .filter(frame => frame.streamEventType === 'cloud.message.queued')
        .every(frame => frame.data.delivery === 'queued')
    ).toBe(true);
    expect(frames.at(-1).streamEventType).toBe('cloud.message.sent');
    for (const frame of frames) processSdkFrame(state, frame);
    expect(state.getCloudStatus()).toEqual({ type: 'ready' });
    expect(state.getActivity()).toEqual({ type: 'busy' });
    expect(state.getStatus()).toEqual({ type: 'idle' });
    expect(state.getPendingMessages().get('old')).toMatchObject({
      status: 'failed',
      error: 'Execution failed',
    });
    processSdkFrame(
      state,
      formatStreamEvent(
        {
          ...makeEvent(
            22,
            JSON.stringify({ messageId: 'current', accepted: true, error: 'Current turn failed' })
          ),
          stream_event_type: 'cloud.message.failed',
        },
        SESSION_ID
      )
    );
    expect(state.getPendingMessages().get('current')).toMatchObject({
      status: 'failed',
      error: 'Current turn failed',
    });
  });

  it.each([undefined, { questions: [], permissions: [] }])(
    'distinguishes unknown interactions from an authoritative empty snapshot: %j',
    async pendingInteractions => {
      const serverWs = makeFakeWebSocket();
      mockWebSocketPair(serverWs);
      const handler = createStreamHandler(makeFakeState(), makeFakeEventQueries([]), SESSION_ID, {
        reconcileMaterializedEvents: true,
        deriveSessionStatus: async () => ({ type: 'idle' }),
        derivePendingInteractions: async () => pendingInteractions,
      });

      await handler.handleStreamRequest(
        new Request('https://example.com/stream?replay=false', {
          headers: { Upgrade: 'websocket' },
        })
      );

      const frames = serverWs.sentMessages.map(message => JSON.parse(message));
      const connected = frames.find(frame => frame.streamEventType === 'connected');
      expect(connected.data.activeMessageId).toBeNull();
      if (pendingInteractions)
        expect(connected.data.pendingInteractions).toEqual(pendingInteractions);
      else expect(connected.data).not.toHaveProperty('pendingInteractions');
    }
  );

  it.each(['fromId=20', 'replay=false'])(
    'reconciles materialized updates and removals without replaying old turn events: %s',
    async query => {
      const serverWs = makeFakeWebSocket();
      mockWebSocketPair(serverWs);
      const events = [
        makeKiloEvent(1, 'message.updated', { info: { id: 'assistant', role: 'assistant' } }),
        makeKiloEvent(2, 'message.part.updated', {
          part: { id: 'text', messageID: 'assistant', type: 'text', text: 'Complete answer' },
        }),
        makeKiloEvent(3, 'message.part.delta', {
          messageID: 'assistant',
          partID: 'text',
          field: 'text',
          delta: 'already materialized',
        }),
        makeKiloEvent(4, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' }),
        makeKiloEvent(5, 'message.part.removed', { messageID: 'assistant', partID: 'old-tool' }),
        makeKiloEvent(6, 'message.removed', { messageID: 'removed-message' }),
        makeKiloEvent(7, 'autocommit_completed', {
          messageId: 'user',
          success: true,
          commitHash: 'abc123',
          message: 'Committed',
        }),
        makeKiloEvent(8, 'session.status', { sessionID: 'ses_root', status: { type: 'busy' } }),
      ];
      const handler = createStreamHandler(
        makeFakeState(),
        makeFakeEventQueries(events),
        SESSION_ID,
        {
          reconcileMaterializedEvents: true,
        }
      );

      await handler.handleStreamRequest(
        new Request(`https://example.com/stream?${query}`, {
          headers: { Upgrade: 'websocket' },
        })
      );

      const frames = serverWs.sentMessages.map(message => JSON.parse(message));
      const snapshots = frames.filter(frame => frame.streamEventType === 'kilocode');
      expect(snapshots.map(frame => frame.data.type)).toEqual([
        'message.updated',
        'message.part.updated',
        'autocommit_completed',
        'message.part.removed',
        'message.removed',
      ]);
      expect(snapshots.every(frame => frame.eventId === 0)).toBe(true);
      expect(snapshots[1].data.properties.part.text).toBe('Complete answer');
    }
  );

  it('filters each snapshot by its actual event type', async () => {
    const serverWs = makeFakeWebSocket();
    mockWebSocketPair(serverWs);
    const handler = createStreamHandler(
      makeFakeState(),
      makeFakeEventQueries([makeKiloEvent(1, 'message.updated', { info: { id: 'assistant' } })]),
      SESSION_ID,
      {
        reconcileMaterializedEvents: true,
        deriveQueuedMessages: async () => [
          {
            messageId: 'failed',
            content: 'Prompt',
            timestamp: 1000,
            terminalFailure: {
              messageId: 'failed',
              status: 'failed',
              delivery: 'queued',
              accepted: false,
              reason: 'exhausted',
              error: 'Execution failed',
              timestamp: 2000,
            },
          },
        ],
      }
    );

    await handler.handleStreamRequest(
      new Request('https://example.com/stream?eventTypes=cloud.message.failed', {
        headers: { Upgrade: 'websocket' },
      })
    );

    const frames = serverWs.sentMessages.map(message => JSON.parse(message));
    expect(frames.map(frame => frame.streamEventType)).toEqual([
      'cloud.message.failed',
      'connected',
    ]);
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
