/**
 * Integration tests for the events query module.
 *
 * Uses @cloudflare/vitest-pool-workers to test against real SQLite in DOs.
 * Each test gets isolated storage automatically.
 *
 * These tests use the /ingest WebSocket to write events and /stream to read them,
 * since the eventQueries are internal to the DO and not exposed via RPC.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as z from 'zod';
import { createEventQueries } from '../../../src/session/queries/events.js';
import type { EventId, SessionId } from '../../../src/types/ids.js';
import { createStreamHandler } from '../../../src/websocket/stream.js';
import { persistSandboxControlSessionEvent } from '../../../src/sandbox-session/sandbox-control-event.js';

const messageUpdatedPayloadSchema = z.object({
  properties: z.object({
    info: z.object({
      text: z.string(),
    }),
  }),
});

// Registered sessions leave dispatch, alarm, and fire-and-forget publication
// work in the session DO. Interrupt every session a test touched, clear its
// alarm, and drain its publication tail, or that work wakes after this file
// closes and its logs race the vitest worker shutdown as pending
// onUserConsoleLog rejections (EnvironmentTeardownError).
const touchedSessions = new Set<string>();

function sessionStub(userId: string, sessionId: string) {
  const sessionName = `${userId}:${sessionId}`;
  touchedSessions.add(sessionName);
  return env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName));
}

afterEach(async () => {
  for (const sessionName of touchedSessions) {
    await runInDurableObject(
      env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName)),
      async (instance, state) => {
        try {
          await instance.interruptExecution();
        } catch {
          // A session that never registered has no work to interrupt.
        }
        await state.storage.deleteAlarm();
        const publicationTail = (instance as any).publicExtensionPublicationTail as
          | Promise<unknown>
          | undefined;
        await publicationTail?.catch(() => undefined);
      }
    ).catch(() => undefined);
  }
  touchedSessions.clear();
});

describe('Event Storage', () => {
  it('should insert event with RETURNING id', async () => {
    const stub = sessionStub('user_1', 'sess_1');

    // Access the DO directly and call queries on its sql storage
    // The DO auto-runs migrations in constructor via blockConcurrencyWhile
    const result = await runInDurableObject(stub, async (_instance, state) => {
      // Create a fresh queries instance using the same storage
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const eventId = events.insert({
        executionId: 'exc_123',
        sessionId: 'sess_1',
        streamEventType: 'output',
        payload: JSON.stringify({ text: 'hello world' }),
        timestamp: Date.now(),
      });

      return { eventId };
    });

    expect(result.eventId).toBeDefined();
    expect(result.eventId).toBeGreaterThan(0);
  });

  it('should find events by filters with various combinations', async () => {
    const stub = sessionStub('user_1', 'sess_2');

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const now = Date.now();

      // Insert multiple events
      events.insert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'output',
        payload: JSON.stringify({ text: 'output 1' }),
        timestamp: now - 5000,
      });
      events.insert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'error',
        payload: JSON.stringify({ message: 'error 1' }),
        timestamp: now - 4000,
      });
      events.insert({
        executionId: 'exc_2',
        sessionId: 'sess_1',
        streamEventType: 'output',
        payload: JSON.stringify({ text: 'output 2' }),
        timestamp: now - 3000,
      });
      events.insert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'complete',
        payload: JSON.stringify({ exitCode: 0 }),
        timestamp: now - 2000,
      });

      // Filter by executionId
      const byExecution = events.findByFilters({ executionIds: ['exc_1'] });

      // Filter by eventType
      const byType = events.findByFilters({ eventTypes: ['output'] });

      // Filter by multiple executionIds
      const byMultiExec = events.findByFilters({ executionIds: ['exc_1', 'exc_2'] });

      // Filter by time range
      const byTimeRange = events.findByFilters({
        startTime: now - 4500,
        endTime: now - 2500,
      });

      // Filter with limit
      const withLimit = events.findByFilters({ limit: 2 });

      // Combined filters
      const combined = events.findByFilters({
        executionIds: ['exc_1'],
        eventTypes: ['output', 'error'],
      });

      return { byExecution, byType, byMultiExec, byTimeRange, withLimit, combined };
    });

    // By execution: 3 events for exc_1
    expect(result.byExecution).toHaveLength(3);
    expect(result.byExecution.every(e => e.execution_id === 'exc_1')).toBe(true);

    // By type: 2 output events
    expect(result.byType).toHaveLength(2);
    expect(result.byType.every(e => e.stream_event_type === 'output')).toBe(true);

    // By multiple executions: all 4 events
    expect(result.byMultiExec).toHaveLength(4);

    // By time range: 2 events (error at -4000 and output 2 at -3000)
    expect(result.byTimeRange).toHaveLength(2);

    // With limit: only 2 events
    expect(result.withLimit).toHaveLength(2);

    // Combined (exc_1 + output/error): 2 events
    expect(result.combined).toHaveLength(2);
  });

  it('should delete events older than timestamp', async () => {
    const stub = sessionStub('user_1', 'sess_3');

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const now = Date.now();

      // Insert events at different times
      const oldTimestamp = now - 100 * 24 * 60 * 60 * 1000; // 100 days ago
      const recentTimestamp = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago

      events.insert({
        executionId: 'exc_old',
        sessionId: 'sess_1',
        streamEventType: 'output',
        payload: JSON.stringify({ text: 'old event' }),
        timestamp: oldTimestamp,
      });
      events.insert({
        executionId: 'exc_recent',
        sessionId: 'sess_1',
        streamEventType: 'output',
        payload: JSON.stringify({ text: 'recent event' }),
        timestamp: recentTimestamp,
      });

      // Count before cleanup
      const beforeCount = events.findByFilters({}).length;

      // Delete events older than 90 days
      const cutoff = now - 90 * 24 * 60 * 60 * 1000;
      const deletedCount = events.deleteOlderThan(cutoff);

      // Get remaining events
      const remaining = events.findByFilters({});

      return { beforeCount, deletedCount, remaining };
    });

    expect(result.beforeCount).toBe(2);
    expect(result.deletedCount).toBe(1);
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0].execution_id).toBe('exc_recent');
  });

  it('should maintain sequential event ordering (IDs always increase)', async () => {
    const stub = sessionStub('user_1', 'sess_4');

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const now = Date.now();

      // Insert events in sequence
      const ids: EventId[] = [];
      for (let i = 0; i < 5; i++) {
        const eventId = events.insert({
          executionId: 'exc_1',
          sessionId: 'sess_1',
          streamEventType: 'output',
          payload: JSON.stringify({ text: `event ${i}` }),
          timestamp: now + i * 100,
        });
        ids.push(eventId);
      }

      // Query all events and verify order
      const allEvents = events.findByFilters({});

      // Query with fromId to skip first 2 (exclusive replay)
      const fromId2 = events.findByFilters({ fromId: ids[1] });

      return { ids, allEvents, fromId2 };
    });

    // IDs should be sequential
    for (let i = 1; i < result.ids.length; i++) {
      expect(result.ids[i]).toBeGreaterThan(result.ids[i - 1]);
    }

    // All events should be returned in ascending ID order
    expect(result.allEvents).toHaveLength(5);
    for (let i = 1; i < result.allEvents.length; i++) {
      expect(result.allEvents[i].id).toBeGreaterThan(result.allEvents[i - 1].id);
    }

    // fromId 2 should return events 3, 4, 5 (exclusive)
    expect(result.fromId2).toHaveLength(3);
    expect(result.fromId2[0].id).toBeGreaterThan(result.ids[1]);
  });

  it('should upsert: insert on first call, update payload on conflict', async () => {
    const stub = sessionStub('user_1', 'sess_5');

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const now = Date.now();

      // First upsert — should create a new row
      const id1 = events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: 'msg_1', text: 'hello' } },
        }),
        timestamp: now,
        entityId: 'message/msg_1',
      });

      // Second upsert with same entityId — should update existing row
      const id2 = events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: 'msg_1', text: 'hello world' } },
        }),
        timestamp: now + 1000,
        entityId: 'message/msg_1',
      });

      // Should still be only 1 row
      const allEvents = events.findByFilters({});

      return { id1, id2, allEvents };
    });

    // Both upserts should return the same row ID (same entity_id)
    expect(result.id1).toBe(result.id2);
    // Only one row in the table
    expect(result.allEvents).toHaveLength(1);
    // Payload should be the latest version
    const payload: unknown = JSON.parse(result.allEvents[0].payload);
    expect(messageUpdatedPayloadSchema.parse(payload).properties.info.text).toBe('hello world');
    // Timestamp should be updated
    expect(result.allEvents[0].stream_event_type).toBe('kilocode');
  });

  it('repairs offline entity mutations below the replay cursor without replaying old execution state', async () => {
    const stub = sessionStub('user_1', 'sess_materialized');
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const events = createEventQueries(drizzle(state.storage), state.storage.sql);
      const sessionId = 'sess_materialized' as SessionId;
      const now = Date.now();
      const text = (value: string) => ({
        executionId: '',
        sessionId,
        streamEventType: 'kilocode',
        timestamp: now,
        entityId: 'part/assistant/text',
        payload: JSON.stringify({
          event: 'message.part.updated',
          properties: {
            part: {
              id: 'text',
              messageID: 'assistant',
              sessionID: 'ses_root',
              type: 'text',
              text: value,
            },
          },
        }),
      });
      const tool = (status: string) => ({
        executionId: '',
        sessionId,
        streamEventType: 'kilocode',
        timestamp: now,
        entityId: 'part/assistant/tool',
        payload: JSON.stringify({
          event: 'message.part.updated',
          properties: {
            part: {
              id: 'tool',
              messageID: 'assistant',
              sessionID: 'ses_root',
              type: 'tool',
              state: { status },
            },
          },
        }),
      });
      const textId = events.upsert(text('Partial'));
      const toolId = events.upsert(tool('running'));
      const fromId = events.insert({
        executionId: '',
        sessionId,
        streamEventType: 'cloud.message.sent',
        timestamp: now,
        payload: JSON.stringify({ messageId: 'user', delivery: 'sent' }),
      });
      const finalTextId = events.upsert(text('Complete answer'));
      const finalToolId = events.upsert(tool('completed'));
      for (const payload of [
        { type: 'message.removed', properties: { sessionID: 'ses_root', messageID: 'removed' } },
        {
          type: 'message.part.removed',
          properties: { sessionID: 'ses_root', messageID: 'assistant', partID: 'old-tool' },
        },
        { type: 'session.turn.close', properties: { sessionID: 'ses_root', reason: 'completed' } },
        {
          type: 'autocommit_completed',
          properties: {
            messageId: 'user',
            success: true,
            commitHash: 'abc123',
            message: 'Committed',
          },
        },
      ]) {
        persistSandboxControlSessionEvent({
          sessionId,
          payload,
          eventQueries: events,
          broadcast: () => {},
        });
      }
      events.insert({
        executionId: '',
        sessionId,
        streamEventType: 'kilocode',
        timestamp: now,
        payload: JSON.stringify({
          event: 'message.part.delta',
          properties: {
            messageID: 'assistant',
            partID: 'text',
            field: 'text',
            delta: 'already materialized',
          },
        }),
      });
      events.insert({
        executionId: '',
        sessionId,
        streamEventType: 'cloud.message.completed',
        timestamp: now,
        payload: JSON.stringify({
          messageId: 'user',
          status: 'completed',
          delivery: 'sent',
          accepted: true,
        }),
      });
      const sent: string[] = [];
      const socket = {
        readyState: WebSocket.OPEN,
        send: (message: string) => sent.push(message),
      } as WebSocket;
      const handler = createStreamHandler(state, events, sessionId, {
        reconcileMaterializedEvents: true,
      });
      await handler.replayEvents(socket, { sessionId, fromId });
      await handler.replayEvents(socket, { sessionId, fromId }, 'updates');
      await handler.replayEvents(socket, { sessionId, fromId }, 'removals');
      return {
        textId,
        toolId,
        finalTextId,
        finalToolId,
        incrementalIds: events.findByFilters({ fromId }).map(event => event.id),
        sent,
      };
    });

    expect(result.finalTextId).toBe(result.textId);
    expect(result.finalToolId).toBe(result.toolId);
    expect(result.incrementalIds).not.toContain(result.textId);
    expect(result.incrementalIds).not.toContain(result.toolId);
    const frames = result.sent.map(message => JSON.parse(message));
    expect(frames.filter(frame => frame.eventId > 0).map(frame => frame.streamEventType)).toEqual([
      'cloud.message.completed',
    ]);
    const snapshots = frames.filter(frame => frame.eventId === 0);
    expect(snapshots.map(frame => frame.data.event)).toEqual([
      'message.part.updated',
      'message.part.updated',
      'autocommit_completed',
      'message.removed',
      'message.part.removed',
    ]);
    expect(snapshots[0].data.properties.part.text).toBe('Complete answer');
    expect(snapshots[1].data.properties.part.state.status).toBe('completed');
    expect(snapshots[2].data.properties.commitHash).toBe('abc123');
  });

  it('should upsert: different entityIds create separate rows', async () => {
    const stub = sessionStub('user_1', 'sess_6');

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const now = Date.now();

      // Upsert two different entities
      const id1 = events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: 'msg_1' } },
        }),
        timestamp: now,
        entityId: 'message/msg_1',
      });

      const id2 = events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: 'msg_2' } },
        }),
        timestamp: now,
        entityId: 'message/msg_2',
      });

      // Also insert a regular event (no entity_id)
      const id3 = events.insert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'output',
        payload: JSON.stringify({ text: 'some output' }),
        timestamp: now,
      });

      const allEvents = events.findByFilters({});

      return { id1, id2, id3, allEvents };
    });

    // Different entity IDs should create different rows
    expect(result.id1).not.toBe(result.id2);
    // Regular insert should create a third row
    expect(result.allEvents).toHaveLength(3);
    // entity_id should not appear in the projected results (StoredEvent type)
    expect(result.allEvents[0]).not.toHaveProperty('entity_id');
  });

  it('should return latest assistant message by sortable message ID with current parts', async () => {
    const stub = sessionStub('user_1', 'sess_7');

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const now = Date.now();
      const latestAssistantId = 'msg_00000000000000000000000002';
      const olderAssistantId = 'msg_00000000000000000000000001';
      const newerUserId = 'msg_00000000000000000000000003';

      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: latestAssistantId, role: 'assistant', sessionID: 'ses_root' } },
        }),
        timestamp: now,
        entityId: `message/${latestAssistantId}`,
      });
      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.part.updated',
          properties: {
            part: {
              id: 'part_00000000000000000000000002',
              messageID: latestAssistantId,
              sessionID: 'ses_root',
              type: 'text',
              text: 'latest answer',
            },
          },
        }),
        timestamp: now + 1,
        entityId: `part/${latestAssistantId}/part_00000000000000000000000002`,
      });
      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.part.updated',
          properties: {
            part: {
              id: 'part_00000000000000000000000003',
              messageID: latestAssistantId,
              sessionID: 'ses_root',
              type: 'text',
              text: 'removed answer',
            },
          },
        }),
        timestamp: now + 2,
        entityId: `part/${latestAssistantId}/part_00000000000000000000000003`,
      });
      events.insert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.part.removed',
          properties: {
            sessionID: 'ses_root',
            messageID: latestAssistantId,
            partID: 'part_00000000000000000000000003',
          },
        }),
        timestamp: now + 3,
      });
      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: olderAssistantId, role: 'assistant', sessionID: 'ses_root' } },
        }),
        timestamp: now + 2,
        entityId: `message/${olderAssistantId}`,
      });
      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: newerUserId, role: 'user', sessionID: 'ses_root' } },
        }),
        timestamp: now + 3,
        entityId: `message/${newerUserId}`,
      });

      return events.getLatestAssistantMessage('sess_1', 'ses_root');
    });

    expect(result?.info.id).toBe('msg_00000000000000000000000002');
    expect(result?.parts).toEqual([
      expect.objectContaining({
        id: 'part_00000000000000000000000002',
        messageID: 'msg_00000000000000000000000002',
        text: 'latest answer',
      }),
    ]);
  });

  it('should require root-session assistant messages', async () => {
    const stub = sessionStub('user_1', 'sess_8');

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const now = Date.now();
      const rootMessageId = 'msg_00000000000000000000000002';
      const childMessageId = 'msg_00000000000000000000000003';

      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: rootMessageId, role: 'assistant', sessionID: 'ses_root' } },
        }),
        timestamp: now,
        entityId: `message/${rootMessageId}`,
      });
      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: { info: { id: childMessageId, role: 'assistant', sessionID: 'ses_child' } },
        }),
        timestamp: now + 1,
        entityId: `message/${childMessageId}`,
      });

      return {
        root: events.getLatestAssistantMessage('sess_1', 'ses_root'),
        missingRoot: events.getLatestAssistantMessage('sess_1', 'ses_missing'),
      };
    });

    expect(result.root?.info.id).toBe('msg_00000000000000000000000002');
    expect(result.missingRoot).toBeNull();
  });

  it('should select and hydrate an assistant without time.completed', async () => {
    const stub = sessionStub('user_1', 'sess_9');

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const events = createEventQueries(db, state.storage.sql);
      const parentMessageId = 'msg_user_0000000000000000000001';
      const olderAssistantId = 'msg_assistant_000000000000000001';
      const latestAssistantId = 'msg_assistant_000000000000000002';

      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: {
            info: {
              id: olderAssistantId,
              role: 'assistant',
              sessionID: 'ses_root',
              parentID: parentMessageId,
              time: { completed: 1 },
            },
          },
        }),
        timestamp: 1,
        entityId: `message/${olderAssistantId}`,
      });
      events.upsert({
        executionId: 'exc_1',
        sessionId: 'sess_1',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: {
            info: {
              id: latestAssistantId,
              role: 'assistant',
              sessionID: 'ses_root',
              parentID: parentMessageId,
            },
          },
        }),
        timestamp: 2,
        entityId: `message/${latestAssistantId}`,
      });

      return {
        selected: events.getAssistantMessageForUserMessage('sess_1', 'ses_root', parentMessageId),
        hydrated: events.getAssistantMessageById(
          'sess_1',
          'ses_root',
          latestAssistantId,
          parentMessageId
        ),
      };
    });

    expect(result.selected?.info.id).toBe('msg_assistant_000000000000000002');
    expect(result.hydrated?.info.id).toBe('msg_assistant_000000000000000002');
  });
});
