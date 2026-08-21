import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import { storePendingSessionMessage } from '../../../src/session/pending-messages.js';
import { putSessionMessageState } from '../../../src/session/session-message-state.js';
import {
  getWrapperLease,
  getWrapperRuntimeState,
} from '../../../src/session/wrapper-runtime-state.js';
import type { ExecutionId } from '../../../src/types/ids.js';
import { registerReadySession } from '../../helpers/session-setup.js';

describe('Disconnect handling and compatibility execution RPCs', () => {
  it('alarm schedules the idle cadence when no current message deadlines exist', async () => {
    const userId = 'user_alarm_idle';
    const sessionId = 'agent_alarm_idle';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      await instance.updateMetadata({ version: now, sessionId, userId, timestamp: now });
      await instance.alarm();
      return { now, nextAlarm: await state.storage.getAlarm() };
    });

    expect(result.nextAlarm).toBeDefined();
    const delta = (result.nextAlarm as number) - result.now;
    expect(delta).toBeGreaterThanOrEqual(3_595_000);
    expect(delta).toBeLessThanOrEqual(3_605_000);
  });

  it('idle cleanup respects accepted wrapper-run messages and pending queue work', async () => {
    const userId = 'user_idle_cleanup';
    const sessionId = 'agent_idle_cleanup';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

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
      const metadataAfterAccepted = await instance.getMetadata();

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
        keptWithAccepted: metadataAfterAccepted?.lifecycle.kiloServerLastActivity,
        keptWithPending: metadataAfterPending?.lifecycle.kiloServerLastActivity,
      };
    });

    expect(result.keptWithAccepted).toBeDefined();
    expect(result.keptWithPending).toBeDefined();
  });

  it('idle cleanup preserves a completed wrapper retained for warm fenced reuse', async () => {
    const userId = 'user_idle_warm_reuse';
    const sessionId = 'agent_idle_warm_reuse';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

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
        wrapperRunId: 'wr_idle_warm_reuse',
        wrapperGeneration: 1,
        wrapperConnectionId: 'connection-completed',
        lastWrapperMessageAt: now,
      });
      await state.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_idle_warm_reuse', instanceGeneration: 1 },
      });

      await instance.handleWrapperTerminalEvent({
        wrapperRunId: 'wr_idle_warm_reuse',
        status: 'completed',
        messageIds: [],
      });
      await instance.alarm();

      return {
        lease: await getWrapperLease(state.storage),
        runtime: await getWrapperRuntimeState(state.storage),
        activity: (await instance.getMetadata())?.lifecycle.kiloServerLastActivity,
      };
    });

    expect(result.lease).toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: expect.any(Number),
    });
    expect(result.runtime.wrapperConnectionId).toBeUndefined();
    expect(result.activity).toBeDefined();
  });

  it('failExecutionRpc retains the public execution-record failure contract', async () => {
    const userId = 'user_rpc_failure';
    const sessionId = 'agent_rpc_failure';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      await instance.updateMetadata({ version: now, sessionId, userId, timestamp: now });
      const executionId = 'exc_rpc_cleanup' as ExecutionId;
      await instance.addExecution({
        executionId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: executionId,
      });
      await instance.updateExecutionStatus({ executionId, status: 'running' });

      const rpcResult = await instance.failExecutionRpc({
        executionId,
        error: 'Interrupted - no running processes found',
      });
      const execution = await instance.getExecution(executionId);
      const events = createEventQueries(
        drizzle(state.storage, { logger: false }),
        state.storage.sql
      ).findByFilters({ executionIds: [executionId] });
      return { rpcResult, execution, events };
    });

    expect(result.rpcResult).toBe(true);
    expect(result.execution?.status).toBe('failed');
    expect(result.execution?.error).toContain('Interrupted - no running processes found');
    const errorEvents = result.events.filter(event => event.stream_event_type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(JSON.parse(errorEvents[0].payload)).toMatchObject({
      fatal: true,
      error: 'Interrupted - no running processes found',
    });
  });

  it('failExecutionRpc is idempotent for an already-terminal execution', async () => {
    const userId = 'user_rpc_terminal';
    const sessionId = 'agent_rpc_terminal';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await instance.updateMetadata({ version: 1, sessionId, userId, timestamp: 1 });
      const executionId = 'exc_rpc_terminal' as ExecutionId;
      await instance.addExecution({
        executionId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: executionId,
      });
      await instance.updateExecutionStatus({ executionId, status: 'running' });
      await instance.updateExecutionStatus({
        executionId,
        status: 'failed',
        error: 'already dead',
      });
      const eventQueries = createEventQueries(
        drizzle(state.storage, { logger: false }),
        state.storage.sql
      );
      const before = eventQueries.findByFilters({ executionIds: [executionId] }).length;
      const rpcResult = await instance.failExecutionRpc({
        executionId,
        error: 'should be a no-op',
      });
      const after = eventQueries.findByFilters({ executionIds: [executionId] }).length;
      return { rpcResult, before, after };
    });

    expect(result.rpcResult).toBe(false);
    expect(result.after).toBe(result.before);
  });

  it('failExecutionRpc preserves the custom event type compatibility input', async () => {
    const userId = 'user_rpc_custom';
    const sessionId = 'agent_rpc_custom';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await instance.updateMetadata({ version: 1, sessionId, userId, timestamp: 1 });
      const executionId = 'exc_rpc_custom_type' as ExecutionId;
      await instance.addExecution({
        executionId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: executionId,
      });
      await instance.updateExecutionStatus({ executionId, status: 'running' });
      const rpcResult = await instance.failExecutionRpc({
        executionId,
        error: 'test',
        streamEventType: 'wrapper_disconnected',
      });
      const events = createEventQueries(
        drizzle(state.storage, { logger: false }),
        state.storage.sql
      ).findByFilters({ executionIds: [executionId] });
      return { rpcResult, events };
    });

    expect(result.rpcResult).toBe(true);
    expect(result.events.some(event => event.stream_event_type === 'wrapper_disconnected')).toBe(
      true
    );
  });

  it('broadcasts cloud.status: ready after a wrapper disconnect and grace expiry', async () => {
    const userId = 'user_disconnect_ready';
    const sessionId = 'agent_disconnect_ready';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'ses_disconnect_ready',
        prompt: 'disconnect ready test',
        mode: 'code',
        model: 'test-model',
      });

      const now = Date.now();
      await state.storage.put('wrapper_runtime_state', {
        wrapperRunId: 'wr_disconnect_ready',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_disconnect_ready',
      });
      await putSessionMessageState(state.storage, {
        messageId: 'msg_018f1e2d3c4bDiscReadyABCDE',
        status: 'accepted',
        prompt: 'disconnect ready test',
        createdAt: now,
        acceptedAt: now,
        wrapperRunId: 'wr_disconnect_ready',
      });
      await state.storage.put('disconnect_grace', {
        wrapperRunId: 'wr_disconnect_ready',
        disconnectedAt: now - 20_000,
        wsCloseCode: 1006,
        wsCloseReason: 'socket closed',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_disconnect_ready',
      });

      const broadcasted: Array<{ stream_event_type: string; payload: string }> = [];
      instance.broadcastEvent = event => {
        broadcasted.push({
          stream_event_type: event.stream_event_type,
          payload: event.payload,
        });
      };

      await instance.alarm();
      return { broadcasted };
    });

    const cloudStatusReady = result.broadcasted.filter(event => {
      if (event.stream_event_type !== 'cloud.status') return false;
      const payload = JSON.parse(event.payload) as { cloudStatus?: { type?: string } };
      return payload.cloudStatus?.type === 'ready';
    });
    expect(cloudStatusReady).toHaveLength(1);
  });

  it('broadcasts cloud.status: ready after a failed wrapper terminal event', async () => {
    const userId = 'user_terminal_ready';
    const sessionId = 'agent_terminal_ready';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'ses_terminal_ready',
        prompt: 'terminal ready test',
        mode: 'code',
        model: 'test-model',
      });

      const now = Date.now();
      await state.storage.put('wrapper_runtime_state', {
        wrapperRunId: 'wr_terminal_ready',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_terminal_ready',
      });
      await putSessionMessageState(state.storage, {
        messageId: 'msg_018f1e2d3c4bTermReadyABCDE',
        status: 'accepted',
        prompt: 'terminal ready test',
        createdAt: now,
        acceptedAt: now,
        wrapperRunId: 'wr_terminal_ready',
      });

      const broadcasted: Array<{ stream_event_type: string; payload: string }> = [];
      instance.broadcastEvent = event => {
        broadcasted.push({
          stream_event_type: event.stream_event_type,
          payload: event.payload,
        });
      };

      await instance.handleWrapperTerminalEvent({
        wrapperRunId: 'wr_terminal_ready',
        status: 'failed',
        error: 'Assistant request failed',
      });
      return { broadcasted };
    });

    const cloudStatusReady = result.broadcasted.filter(event => {
      if (event.stream_event_type !== 'cloud.status') return false;
      const payload = JSON.parse(event.payload) as { cloudStatus?: { type?: string } };
      return payload.cloudStatus?.type === 'ready';
    });
    expect(cloudStatusReady).toHaveLength(1);
  });

  it('does not broadcast cloud.status: ready for a stale wrapper terminal event', async () => {
    const userId = 'user_stale_terminal';
    const sessionId = 'agent_stale_terminal';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'ses_stale_terminal',
        prompt: 'stale terminal test',
        mode: 'code',
        model: 'test-model',
      });

      const now = Date.now();
      await state.storage.put('wrapper_runtime_state', {
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      });
      await putSessionMessageState(state.storage, {
        messageId: 'msg_018f1e2d3c4bStaleTermABCDE',
        status: 'accepted',
        prompt: 'stale terminal test',
        createdAt: now,
        acceptedAt: now,
        wrapperRunId: 'wr_current',
      });

      const broadcasted: Array<{ stream_event_type: string; payload: string }> = [];
      instance.broadcastEvent = event => {
        broadcasted.push({
          stream_event_type: event.stream_event_type,
          payload: event.payload,
        });
      };

      await instance.handleWrapperTerminalEvent({
        wrapperRunId: 'wr_stale',
        status: 'failed',
        error: 'Assistant request failed',
      });
      return { broadcasted };
    });

    const cloudStatusReady = result.broadcasted.filter(event => {
      if (event.stream_event_type !== 'cloud.status') return false;
      const payload = JSON.parse(event.payload) as { cloudStatus?: { type?: string } };
      return payload.cloudStatus?.type === 'ready';
    });
    expect(cloudStatusReady).toHaveLength(0);
  });
});
