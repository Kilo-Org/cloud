/**
 * Integration tests for the events query module.
 *
 * Uses @cloudflare/vitest-pool-workers to test against real SQLite in DOs.
 * Each test gets isolated storage automatically.
 *
 * These tests use the /ingest WebSocket to write events and /stream to read them,
 * since the eventQueries are internal to the DO and not exposed via RPC.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { createEventQueries } from '../../../src/session/queries/events.js';
import type { EventId } from '../../../src/types/ids.js';

describe('Event Storage', () => {
  beforeEach(async () => {
    // Verify previous test's DOs are automatically removed (isolation)
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    expect(ids).toHaveLength(0);
  });

  it('should insert event with RETURNING id', async () => {
    const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_1');
    const stub = env.CLOUD_AGENT_SESSION.get(id);

    // Access the DO directly and call queries on its sql storage
    // The DO auto-runs migrations in constructor via blockConcurrencyWhile
    const result = await runInDurableObject(stub, async (_instance, state) => {
      // Create a fresh queries instance using the same storage
      const events = createEventQueries(state.storage.sql);
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
    const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_2');
    const stub = env.CLOUD_AGENT_SESSION.get(id);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const events = createEventQueries(state.storage.sql);
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
    const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_3');
    const stub = env.CLOUD_AGENT_SESSION.get(id);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const events = createEventQueries(state.storage.sql);
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
    const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_4');
    const stub = env.CLOUD_AGENT_SESSION.get(id);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const events = createEventQueries(state.storage.sql);
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
});
