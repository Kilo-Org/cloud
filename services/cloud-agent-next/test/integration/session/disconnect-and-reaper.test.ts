/**
 * Integration tests for disconnect handling, alarm deadline scheduling,
 * execution timeouts, and idle cleanup gating.
 *
 * Uses @cloudflare/vitest-pool-workers to test against real SQLite in DOs.
 * Each test gets isolated storage automatically.
 *
 * Note: webSocketClose cannot be tested directly in integration because it
 * requires a real ingest WebSocket established via handleIngestRequest inside
 * the DO. Instead we test the reaper (alarm) path which exercises the same
 * cleanup and event-insertion logic.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import { storePendingSessionMessage } from '../../../src/session/pending-messages.js';
import { putSessionMessageState } from '../../../src/session/session-message-state.js';
import type { ExecutionId } from '../../../src/types/ids.js';

describe('Disconnect handling & reaper', () => {
  // ---------------------------------------------------------------------------
  // Active execution timeout and cleanup behavior
  // ---------------------------------------------------------------------------

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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });

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

      const currentRuntimeExecution = await instance.getCurrentRuntimeExecution();

      return { execution, errorEvents, currentRuntimeExecution };
    });

    expect(result.execution?.status).toBe('running');
    expect(result.currentRuntimeExecution?.executionId).toBe('exc_fresh');
    expect(result.errorEvents).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Deadline-based alarm scheduling for max runtime and idle cadence
  // ---------------------------------------------------------------------------

  it('alarm schedules max-runtime deadline for current wrapper runtime execution', async () => {
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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedMessageId: 'msg_current',
        acceptedExecutionId: excId,
      });

      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });

      await instance.updateExecutionHeartbeat(excId, now - 5_000);

      await instance.alarm();

      // Read the scheduled alarm time
      const nextAlarm = await state.storage.getAlarm();

      return { nextAlarm, now };
    });

    expect(result.nextAlarm).toBeDefined();
    const delta = (result.nextAlarm as number) - result.now;
    expect(delta).toBeGreaterThanOrEqual(3_595_000);
    expect(delta).toBeLessThanOrEqual(3_605_000);
  });

  it('alarm schedules 1-hour interval when no pending runtime deadlines exist', async () => {
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

      // No pending runtime deadlines -- just metadata

      // Run the alarm
      await instance.alarm();

      const nextAlarm = await state.storage.getAlarm();

      return { nextAlarm, now };
    });

    expect(result.nextAlarm).toBeDefined();
    const delta = (result.nextAlarm as number) - result.now;
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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });

      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });

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
      const currentRuntimeExecution = await instance.getCurrentRuntimeExecution();

      // The grace state should be cleared after processing
      const graceAfter = await state.storage.get('disconnect_grace');

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const disconnectEvents = events.filter(e => e.stream_event_type === 'wrapper_disconnected');

      return { execution, currentRuntimeExecution, graceAfter, disconnectEvents };
    });

    expect(result.execution?.status).toBe('failed');
    expect(result.execution?.error).toBe('Wrapper disconnected');
    expect(result.currentRuntimeExecution).toBeNull();
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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });

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
      const currentRuntimeExecution = await instance.getCurrentRuntimeExecution();
      // Grace state should still be present (not yet expired)
      const graceAfter = await state.storage.get('disconnect_grace');

      return { execution, currentRuntimeExecution, graceAfter };
    });

    expect(result.execution?.status).toBe('running');
    expect(result.currentRuntimeExecution?.executionId).toBe('exc_grace_not_expired');
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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });

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

  it('failExecution clears fenced disconnect grace for the same execution', async () => {
    const userId = 'user_grace_terminal';
    const sessionId = 'agent_grace_terminal';
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

      const excId = 'exc_fenced_grace_terminal' as ExecutionId;
      await instance.addExecution({
        executionId: excId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: excId,
      });
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 7,
        wrapperConnectionId: 'connection-fenced',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });
      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });

      await state.storage.put('disconnect_grace', {
        executionId: excId,
        disconnectedAt: now - 15_000,
        wsCloseCode: 1006,
        wsCloseReason: 'test fenced grace',
        wrapperGeneration: 7,
        wrapperConnectionId: 'connection-fenced',
      });

      const failed = await instance.failExecutionRpc({
        executionId: excId,
        status: 'failed',
        error: 'non-reconnect failure',
        streamEventType: 'error',
      });
      const graceAfterFailure = await state.storage.get('disconnect_grace');

      await instance.alarm();

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const errorEvents = events.filter(e => e.stream_event_type === 'error');
      const disconnectEvents = events.filter(e => e.stream_event_type === 'wrapper_disconnected');
      const execution = await instance.getExecution(excId);

      return { failed, graceAfterFailure, errorEvents, disconnectEvents, execution };
    });

    expect(result.failed).toBe(true);
    expect(result.graceAfterFailure).toBeUndefined();
    expect(result.execution?.status).toBe('failed');
    expect(result.errorEvents).toHaveLength(1);
    expect(result.disconnectEvents).toHaveLength(0);
  });

  it('max runtime reaper is idempotent - second alarm after failure produces no additional events', async () => {
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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedMessageId: 'msg_current',
        acceptedExecutionId: excId,
      });

      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });

      const executions =
        await state.storage.get<Array<{ executionId: string; startedAt: number }>>('executions');
      const storedExecution = executions?.find(e => e.executionId === excId);
      if (storedExecution) {
        storedExecution.startedAt = now - 61 * 60 * 1000;
        await state.storage.put('executions', executions);
      }

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
      const currentRuntimeExecution = await instance.getCurrentRuntimeExecution();

      return { errorCountAfterFirst, errorCountAfterSecond, execution, currentRuntimeExecution };
    });

    expect(result.errorCountAfterFirst).toBe(1);
    expect(result.errorCountAfterSecond).toBe(1);
    expect(result.execution?.status).toBe('failed');
    expect(result.currentRuntimeExecution).toBeNull();
  });

  it('max runtime uses current wrapper runtime only', async () => {
    const userId = 'user_reaper_runtime';
    const sessionId = 'agent_reaper_runtime';
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

      const unrelatedId = 'exc_unrelated_running' as ExecutionId;
      await instance.addExecution({
        executionId: unrelatedId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: unrelatedId,
      });
      await instance.updateExecutionStatus({
        executionId: unrelatedId,
        status: 'running',
      });

      const runtimeId = 'exc_runtime_current' as ExecutionId;
      await instance.addExecution({
        executionId: runtimeId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: runtimeId,
      });
      await instance.updateExecutionStatus({
        executionId: runtimeId,
        status: 'running',
      });
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: runtimeId,
        acceptedMessageId: 'msg_current',
        acceptedExecutionId: runtimeId,
      });

      const executions =
        await state.storage.get<Array<{ executionId: string; startedAt: number }>>('executions');
      const storedRuntimeExecution = executions?.find(e => e.executionId === runtimeId);
      if (storedRuntimeExecution) {
        storedRuntimeExecution.startedAt = now - 61 * 60 * 1000;
        await state.storage.put('executions', executions);
      }

      await instance.alarm();

      const unrelatedExecution = await instance.getExecution(unrelatedId);
      const runtimeExecution = await instance.getExecution(runtimeId);

      return { unrelatedExecution, runtimeExecution };
    });

    expect(result.unrelatedExecution?.status).toBe('running');
    expect(result.runtimeExecution?.status).toBe('failed');
  });

  it('reaper clears interrupt flag when max runtime fails execution', async () => {
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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedMessageId: 'msg_current',
        acceptedExecutionId: excId,
      });

      await instance.updateExecutionStatus({
        executionId: excId,
        status: 'running',
      });

      const executions =
        await state.storage.get<Array<{ executionId: string; startedAt: number }>>('executions');
      const storedExecution = executions?.find(e => e.executionId === excId);
      if (storedExecution) {
        storedExecution.startedAt = now - 61 * 60 * 1000;
        await state.storage.put('executions', executions);
      }

      // Set the interrupt flag before the reaper runs
      await instance.requestInterrupt();
      const interruptBefore = await instance.isInterruptRequested();

      // Run the alarm — max runtime should fail the execution AND clear the interrupt
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
  // Idle kilo server cleanup
  // ---------------------------------------------------------------------------

  it('idle cleanup respects runtime and pending work', async () => {
    const userId = 'user_idle_cleanup';
    const sessionId = 'agent_idle_cleanup';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      const expiredActivity = now - 20 * 60 * 1000;

      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
        kiloServerLastActivity: expiredActivity,
      });
      await state.storage.put('wrapper_runtime_state', {
        wrapperRunId: 'wr_idle_cleanup',
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        lastWrapperMessageAt: now,
        wrapperExecutionId: 'execution-current',
        acceptedMessageId: 'msg_current',
        acceptedExecutionId: 'execution-current',
      });
      await putSessionMessageState(state.storage, {
        messageId: 'msg_018f1e2d3c4bIdleRuntimeAbC',
        status: 'accepted',
        prompt: 'running task',
        createdAt: now,
        acceptedAt: now,
        wrapperRunId: 'wr_idle_cleanup',
      });

      await instance.alarm();
      const metadataAfterRuntime = await instance.getMetadata();

      await state.storage.delete('wrapper_runtime_state');
      await storePendingSessionMessage(state.storage, {
        messageId: 'msg_123456789abc123456789abc12',
        role: 'user',
        content: 'queued',
        createdAt: now,
      });

      await instance.alarm();
      const metadataAfterPending = await instance.getMetadata();

      return {
        keptWithRuntime: metadataAfterRuntime?.lifecycle.kiloServerLastActivity,
        keptWithPending: metadataAfterPending?.lifecycle.kiloServerLastActivity,
      };
    });

    expect(result.keptWithRuntime).toBeDefined();
    expect(result.keptWithPending).toBeDefined();
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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });

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
      const currentRuntimeExecution = await instance.getCurrentRuntimeExecution();
      const interruptAfter = await instance.isInterruptRequested();

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ executionIds: [excId] });
      const errorEvents = events.filter(e => e.stream_event_type === 'error');

      return { rpcResult, execution, currentRuntimeExecution, interruptAfter, errorEvents };
    });

    expect(result.rpcResult).toBe(true);
    expect(result.execution?.status).toBe('failed');
    expect(result.execution?.error).toContain('Interrupted - no running processes found');
    expect(result.currentRuntimeExecution).toBeNull();
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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });

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
      await state.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-current',
        wrapperExecutionId: excId,
        acceptedExecutionId: excId,
      });

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
