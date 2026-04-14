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

      // Set a heartbeat old enough to be stale under default and configured thresholds.
      const staleHeartbeat = now - 11 * 60 * 1000;
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

      // Set a recent heartbeat (10 seconds ago — well within stale thresholds)
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
  // Fix 5: Dynamic alarm scheduling — 2-min interval when active, 1-hour idle
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

  it('alarm schedules 1-hour interval when no active execution exists', async () => {
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

    // 1-hour idle interval = 3_600_000 ms
    expect(result.nextAlarm).toBeDefined();
    const delta = (result.nextAlarm as number) - result.now;
    // Allow ± 5s for clock drift
    expect(delta).toBeGreaterThanOrEqual(3_595_000);
    expect(delta).toBeLessThanOrEqual(3_605_000);
  });

  // ---------------------------------------------------------------------------
  // Disconnect grace period (alarm-based, survives hibernation)
  // ---------------------------------------------------------------------------

  it('alarm fires disconnect grace and marks execution as failed', async () => {
    const userId = 'user_grace_1';
    const sessionId = 'agent_grace_1';
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

      const excId = 'exc_grace_expired' as ExecutionId;
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

      // Fresh heartbeat so the reaper's stale-execution check won't trigger
      await instance.updateExecutionHeartbeat(excId, now - 5_000);

      // Simulate writing the disconnect grace state directly into storage
      // (normally done by webSocketClose → startDisconnectGrace, which we
      // can't call without a real ingest WebSocket).
      const graceState = {
        executionId: excId,
        disconnectedAt: now - 15_000, // 15s ago — well past the 10s grace
        wsCloseCode: 1006,
        wsCloseReason: 'WebSocket disconnected without sending Close frame.',
      };
      await state.storage.put('disconnect_grace', graceState);

      // Run the alarm — should detect expired grace and fail the execution
      await instance.alarm();

      const execution = await instance.getExecution(excId);
      const activeExecId = await instance.getActiveExecutionId();

      // The grace state should be cleared after processing
      const graceAfter = await state.storage.get('disconnect_grace');

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const disconnectEvents = events.filter(e => e.stream_event_type === 'wrapper_disconnected');

      return { execution, activeExecId, graceAfter, disconnectEvents };
    });

    expect(result.execution?.status).toBe('failed');
    expect(result.execution?.error).toBe('Wrapper disconnected');
    expect(result.activeExecId).toBeNull();
    expect(result.graceAfter).toBeUndefined();
    expect(result.disconnectEvents).toHaveLength(1);

    const payload = JSON.parse(result.disconnectEvents[0].payload);
    expect(payload.wsCloseCode).toBe(1006);
  });

  it('alarm skips disconnect grace when period has not yet elapsed', async () => {
    const userId = 'user_grace_2';
    const sessionId = 'agent_grace_2';
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

      const excId = 'exc_grace_not_expired' as ExecutionId;
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

      await instance.updateExecutionHeartbeat(excId, now - 5_000);

      // Grace period started only 3s ago — not yet expired (10s threshold)
      const graceState = {
        executionId: excId,
        disconnectedAt: now - 3_000,
        wsCloseCode: 1006,
        wsCloseReason: 'test',
      };
      await state.storage.put('disconnect_grace', graceState);

      await instance.alarm();

      const execution = await instance.getExecution(excId);
      const activeExecId = await instance.getActiveExecutionId();
      // Grace state should still be present (not yet expired)
      const graceAfter = await state.storage.get('disconnect_grace');

      return { execution, activeExecId, graceAfter };
    });

    expect(result.execution?.status).toBe('running');
    expect(result.activeExecId).toBe('exc_grace_not_expired');
    expect(result.graceAfter).toBeDefined();
  });

  it('alarm skips disconnect grace when execution already completed', async () => {
    const userId = 'user_grace_3';
    const sessionId = 'agent_grace_3';
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

      const excId = 'exc_grace_completed' as ExecutionId;
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

      // Complete the execution before the alarm fires
      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'completed',
      });

      // Grace state from before the execution completed
      const graceState = {
        executionId: excId,
        disconnectedAt: now - 15_000,
        wsCloseCode: 1006,
        wsCloseReason: 'test',
      };
      await state.storage.put('disconnect_grace', graceState);

      await instance.alarm();

      const execution = await instance.getExecution(excId);

      // Grace state should be cleared even though we didn't fail
      const graceAfter = await state.storage.get('disconnect_grace');

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const disconnectEvents = events.filter(e => e.stream_event_type === 'wrapper_disconnected');

      return { execution, graceAfter, disconnectEvents };
    });

    expect(result.execution?.status).toBe('completed');
    expect(result.graceAfter).toBeUndefined();
    expect(result.disconnectEvents).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // failExecution idempotency & interrupt cleanup
  // ---------------------------------------------------------------------------

  it('reaper is idempotent - second alarm after failure produces no additional events', async () => {
    const userId = 'user_reaper_5';
    const sessionId = 'agent_reaper_5';
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

      const excId = 'exc_idempotent' as ExecutionId;
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

      // Stale heartbeat — exceeds default and configured thresholds.
      await instance.updateExecutionHeartbeat(excId, now - 11 * 60 * 1000);

      // First alarm: should mark execution as failed and insert error event
      await instance.alarm();

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);

      const eventsAfterFirst = eventQueries.findByFilters({ executionIds: [excId] });
      const errorCountAfterFirst = eventsAfterFirst.filter(
        e => e.stream_event_type === 'error'
      ).length;

      // Second alarm: execution is already terminal — should be a no-op
      await instance.alarm();

      const eventsAfterSecond = eventQueries.findByFilters({ executionIds: [excId] });
      const errorCountAfterSecond = eventsAfterSecond.filter(
        e => e.stream_event_type === 'error'
      ).length;

      const execution = await instance.getExecution(excId);
      const activeExecId = await instance.getActiveExecutionId();

      return { errorCountAfterFirst, errorCountAfterSecond, execution, activeExecId };
    });

    expect(result.errorCountAfterFirst).toBe(1);
    expect(result.errorCountAfterSecond).toBe(1);
    expect(result.execution?.status).toBe('failed');
    expect(result.activeExecId).toBeNull();
  });

  it('reaper clears interrupt flag when marking stale execution as failed', async () => {
    const userId = 'user_reaper_6';
    const sessionId = 'agent_reaper_6';
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

      const excId = 'exc_interrupt_clear' as ExecutionId;
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

      // Stale heartbeat — exceeds default and configured thresholds.
      await instance.updateExecutionHeartbeat(excId, now - 11 * 60 * 1000);

      // Set the interrupt flag before the reaper runs
      await instance.requestInterrupt();
      const interruptBefore = await instance.isInterruptRequested();

      // Run the alarm — reaper should fail the execution AND clear the interrupt
      await instance.alarm();

      const execution = await instance.getExecution(excId);
      const interruptAfter = await instance.isInterruptRequested();

      return { execution, interruptBefore, interruptAfter };
    });

    expect(result.interruptBefore).toBe(true);
    expect(result.execution?.status).toBe('failed');
    expect(result.interruptAfter).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // failExecutionRpc — direct RPC path for external callers
  // ---------------------------------------------------------------------------

  it('failExecutionRpc marks execution as failed with full cleanup', async () => {
    const userId = 'user_rpc_1';
    const sessionId = 'agent_rpc_1';
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

      const excId = 'exc_rpc_cleanup' as ExecutionId;
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

      // Set the interrupt flag so we can verify it gets cleared
      await instance.requestInterrupt();

      const rpcResult = await instance.failExecutionRpc({
        executionId: excId,
        error: 'Interrupted - no running processes found',
      });

      const execution = await instance.getExecution(excId);
      const activeExecId = await instance.getActiveExecutionId();
      const interruptAfter = await instance.isInterruptRequested();

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const errorEvents = events.filter(e => e.stream_event_type === 'error');

      return { rpcResult, execution, activeExecId, interruptAfter, errorEvents };
    });

    expect(result.rpcResult).toBe(true);
    expect(result.execution?.status).toBe('failed');
    expect(result.execution?.error).toContain('Interrupted - no running processes found');
    expect(result.activeExecId).toBeNull();
    expect(result.interruptAfter).toBe(false);
    expect(result.errorEvents).toHaveLength(1);

    const payload = JSON.parse(result.errorEvents[0].payload);
    expect(payload.fatal).toBe(true);
    expect(payload.error).toContain('Interrupted - no running processes found');
  });

  it('failExecutionRpc returns false for already-terminal execution', async () => {
    const userId = 'user_rpc_2';
    const sessionId = 'agent_rpc_2';
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

      const excId = 'exc_rpc_terminal' as ExecutionId;
      await instance.addExecution({
        executionId: excId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: excId,
      });
      await instance.setActiveExecution(excId);

      // Transition to running, then to failed
      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });
      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'failed',
        error: 'already dead',
      });

      // Count events before the RPC call
      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const eventsBefore = eventQueries.findByFilters({ executionIds: [excId] });
      const errorCountBefore = eventsBefore.filter(e => e.stream_event_type === 'error').length;

      // Now call failExecutionRpc on the already-terminal execution
      const rpcResult = await instance.failExecutionRpc({
        executionId: excId,
        error: 'should be a no-op',
      });

      const eventsAfter = eventQueries.findByFilters({ executionIds: [excId] });
      const errorCountAfter = eventsAfter.filter(e => e.stream_event_type === 'error').length;

      return { rpcResult, errorCountBefore, errorCountAfter };
    });

    expect(result.rpcResult).toBe(false);
    expect(result.errorCountAfter).toBe(result.errorCountBefore);
  });

  it('failExecutionRpc passes custom streamEventType', async () => {
    const userId = 'user_rpc_3';
    const sessionId = 'agent_rpc_3';
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

      const excId = 'exc_rpc_custom_type' as ExecutionId;
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

      const rpcResult = await instance.failExecutionRpc({
        executionId: excId,
        error: 'test',
        streamEventType: 'wrapper_disconnected',
      });

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const customEvents = events.filter(e => e.stream_event_type === 'wrapper_disconnected');

      return { rpcResult, customEvents };
    });

    expect(result.rpcResult).toBe(true);
    expect(result.customEvents).toHaveLength(1);
    expect(result.customEvents[0].stream_event_type).toBe('wrapper_disconnected');
  });
});
