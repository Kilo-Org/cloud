import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import { storePendingSessionMessage } from '../../../src/session/pending-messages.js';
import { putSessionMessageState } from '../../../src/session/session-message-state.js';
import {
  getWrapperLease,
  getWrapperRuntimeState,
} from '../../../src/session/wrapper-runtime-state.js';
import type { ExecutionId } from '../../../src/types/ids.js';

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

describe('Disconnect handling and compatibility execution RPCs', () => {
  it('alarm schedules the idle cadence when no current message deadlines exist', async () => {
    const userId = 'user_alarm_idle';
    const sessionId = 'agent_alarm_idle';
    const stub = sessionStub(userId, sessionId);

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
    const stub = sessionStub(userId, sessionId);

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
    const stub = sessionStub(userId, sessionId);

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
    const stub = sessionStub(userId, sessionId);

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
    const stub = sessionStub(userId, sessionId);

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
    const stub = sessionStub(userId, sessionId);

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
});
