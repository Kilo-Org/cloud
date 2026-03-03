/**
 * Integration tests for disconnect handling (Fix 1), reaper event emission (Fix 4),
 * and dynamic alarm scheduling (Fix 5).
 *
 * Uses @cloudflare/vitest-pool-workers to test against real SQLite in DOs.
 * Each test gets isolated storage automatically.
 *
 * Note: webSocketClose cannot be tested directly in integration because it
 * requires a real ingest WebSocket established via handleIngestRequest inside
 * the DO. Instead we test the reaper (alarm) path which exercises the same
 * cleanup and event-insertion logic.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import type { ExecutionId } from '../../../src/types/ids.js';

describe('Disconnect handling & reaper', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    expect(ids).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Fix 4: Reaper inserts synthetic error events when marking executions failed
  // ---------------------------------------------------------------------------

  it('reaper marks stale running execution as failed and inserts error event', async () => {
    const userId = 'user_reaper_1';
    const sessionId = 'agent_reaper_1';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();

      // Setup session metadata
      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      // Add an execution and make it active
      const excId = 'exc_stale_running' as ExecutionId;
      await instance.addExecution({
        executionId: excId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: excId,
      });
      await instance.setActiveExecution(excId);

      // Transition to running
      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });

      // Set a heartbeat old enough to be stale (>90s threshold)
      const staleHeartbeat = now - 200_000;
      await instance.updateExecutionHeartbeat(excId, staleHeartbeat);

      // Run the alarm (reaper)
      await instance.alarm();

      // Check execution status
      const execution = await instance.getExecution(excId);

      // Check events for synthetic error event
      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const errorEvents = events.filter(e => e.stream_event_type === 'error');

      // Check active execution was cleared
      const activeExecId = await instance.getActiveExecutionId();

      return { execution, errorEvents, activeExecId };
    });

    expect(result.execution?.status).toBe('failed');
    expect(result.execution?.error).toContain('no heartbeat');
    expect(result.activeExecId).toBeNull();
    expect(result.errorEvents).toHaveLength(1);

    const payload = JSON.parse(result.errorEvents[0].payload);
    expect(payload.fatal).toBe(true);
    expect(payload.error).toContain('no heartbeat');
  });

  it('reaper marks stuck pending execution as failed and inserts error event', async () => {
    const userId = 'user_reaper_2';
    const sessionId = 'agent_reaper_2';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();

      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      const excId = 'exc_stale_pending' as ExecutionId;
      await instance.addExecution({
        executionId: excId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: excId,
      });
      await instance.setActiveExecution(excId);
      // Execution starts as 'pending' — leave it there.

      // The pending timeout is 5 minutes by default. We need the execution's
      // startedAt to be far enough in the past. Because addExecution uses
      // Date.now() internally, we can't control it directly. Instead we
      // manipulate the execution storage to backdate startedAt.
      const executions =
        await state.storage.get<
          Array<{ executionId: string; startedAt: number; [k: string]: unknown }>
        >('executions');
      if (executions) {
        const idx = executions.findIndex(e => e.executionId === excId);
        if (idx !== -1) {
          // 6 minutes ago — exceeds the 5-minute default pending timeout
          executions[idx].startedAt = now - 6 * 60 * 1000;
          await state.storage.put('executions', executions);
        }
      }

      // Run the alarm (reaper)
      await instance.alarm();

      const execution = await instance.getExecution(excId);

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const errorEvents = events.filter(e => e.stream_event_type === 'error');

      const activeExecId = await instance.getActiveExecutionId();

      return { execution, errorEvents, activeExecId };
    });

    expect(result.execution?.status).toBe('failed');
    expect(result.execution?.error).toContain('wrapper never connected');
    expect(result.activeExecId).toBeNull();
    expect(result.errorEvents).toHaveLength(1);

    const payload = JSON.parse(result.errorEvents[0].payload);
    expect(payload.fatal).toBe(true);
    expect(payload.error).toContain('wrapper never connected');
  });

  it('reaper does NOT mark execution as failed when heartbeat is fresh', async () => {
    const userId = 'user_reaper_3';
    const sessionId = 'agent_reaper_3';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();

      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      const excId = 'exc_fresh' as ExecutionId;
      await instance.addExecution({
        executionId: excId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: excId,
      });
      await instance.setActiveExecution(excId);

      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });

      // Set a recent heartbeat (10 seconds ago — well within 90s threshold)
      await instance.updateExecutionHeartbeat(excId, now - 10_000);

      // Run the alarm (reaper)
      await instance.alarm();

      const execution = await instance.getExecution(excId);

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const errorEvents = events.filter(e => e.stream_event_type === 'error');

      const activeExecId = await instance.getActiveExecutionId();

      return { execution, errorEvents, activeExecId };
    });

    expect(result.execution?.status).toBe('running');
    expect(result.activeExecId).toBe('exc_fresh');
    expect(result.errorEvents).toHaveLength(0);
  });

  it('reaper clears orphaned active execution ID', async () => {
    const userId = 'user_reaper_4';
    const sessionId = 'agent_reaper_4';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();

      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      // Write a dangling active execution ID directly into storage — the
      // execution itself was never added, simulating an orphan.
      await state.storage.put('active_execution_id', 'exc_orphan');

      // Run the alarm (reaper)
      await instance.alarm();

      const activeExecId = await instance.getActiveExecutionId();

      return { activeExecId };
    });

    expect(result.activeExecId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Fix 5: Dynamic alarm scheduling — 2-min interval when active, 5-min idle
  // ---------------------------------------------------------------------------

  it('alarm schedules 2-minute interval when an active execution exists', async () => {
    const userId = 'user_alarm_1';
    const sessionId = 'agent_alarm_1';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();

      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      const excId = 'exc_active_alarm' as ExecutionId;
      await instance.addExecution({
        executionId: excId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: excId,
      });
      await instance.setActiveExecution(excId);

      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });

      // Fresh heartbeat so the reaper won't kill it
      await instance.updateExecutionHeartbeat(excId, now - 5_000);

      // Run the alarm
      await instance.alarm();

      // Read the scheduled alarm time
      const nextAlarm = await state.storage.getAlarm();

      return { nextAlarm, now };
    });

    // 2-minute active interval = 120_000 ms
    expect(result.nextAlarm).toBeDefined();
    const delta = (result.nextAlarm as number) - result.now;
    // Allow ± 5s for clock drift inside the DO
    expect(delta).toBeGreaterThanOrEqual(115_000);
    expect(delta).toBeLessThanOrEqual(125_000);
  });

  it('alarm schedules 5-minute interval when no active execution exists', async () => {
    const userId = 'user_alarm_2';
    const sessionId = 'agent_alarm_2';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();

      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      // No active execution — just metadata

      // Run the alarm
      await instance.alarm();

      const nextAlarm = await state.storage.getAlarm();

      return { nextAlarm, now };
    });

    // 5-minute default interval = 300_000 ms
    expect(result.nextAlarm).toBeDefined();
    const delta = (result.nextAlarm as number) - result.now;
    // Allow ± 5s for clock drift
    expect(delta).toBeGreaterThanOrEqual(295_000);
    expect(delta).toBeLessThanOrEqual(305_000);
  });
});
