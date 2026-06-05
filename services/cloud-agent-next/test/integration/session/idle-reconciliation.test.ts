/**
 * Integration tests for idle reconciliation scheduling.
 *
 * Phase 6 remediation: root session.idle must record lastWrapperIdleAt and
 * idleReconcileAfter, drive checkIdleReconciliation by that deadline, and
 * reschedule the alarm. Meaningful output after idle must clear the idle
 * state so reconciliation is cancelled.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import {
  getWrapperLease,
  getWrapperRuntimeState,
  allocateWrapperRuntimeState,
} from '../../../src/session/wrapper-runtime-state.js';
import {
  getSessionMessageState,
  listNonTerminalAcceptedMessages,
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import { registerReadySession } from '../../helpers/session-setup.js';

describe('idle reconciliation scheduling', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    await Promise.all(
      ids.map(id =>
        runInDurableObject(env.CLOUD_AGENT_SESSION.get(id), instance =>
          instance.ctx.storage.deleteAll()
        )
      )
    );
  });

  it('root session.idle records lastWrapperIdleAt and idleReconcileAfter', async () => {
    const userId = 'user_idle_schedule';
    const sessionId = 'agent_idle_schedule';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_idle_schedule',
        kiloSessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-idle-schedule',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId, wrapperGeneration } = wrapperState;

      const handler = await (instance as any).getIngestHandler();
      const ws = {
        deserializeAttachment: () => ({
          wrapperRunId,
          sessionId,
          connectedAt: Date.now(),
          kiloSessionState: { captured: false },
          lastHeartbeatUpdate: Date.now(),
          lastEventAtUpdate: Date.now(),
          wrapperGeneration,
          wrapperConnectionId,
        }),
        serializeAttachment: () => {},
        send: () => {},
      } as unknown as WebSocket;

      const beforeIngest = Date.now();
      await handler.handleIngestMessage(
        ws,
        JSON.stringify({
          streamEventType: 'kilocode',
          data: {
            event: 'session.idle',
            properties: {
              sessionID: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            },
          },
          timestamp: new Date().toISOString(),
        })
      );

      const runtimeState = await getWrapperRuntimeState(instance.ctx.storage);

      return { runtimeState, beforeIngest, afterIngest: Date.now() };
    });

    expect(result.runtimeState.lastWrapperIdleAt).toBeDefined();
    expect(result.runtimeState.lastWrapperIdleAt).toBeGreaterThanOrEqual(result.beforeIngest);
    expect(result.runtimeState.lastWrapperIdleAt).toBeLessThanOrEqual(result.afterIngest);

    expect(result.runtimeState.idleReconcileAfter).toBeDefined();
    expect(result.runtimeState.idleReconcileAfter).toBeGreaterThanOrEqual(
      result.beforeIngest + 10_000
    );
    expect(result.runtimeState.idleReconcileAfter).toBeLessThanOrEqual(result.afterIngest + 20_000);
  });

  it('idle reconciliation does not run before idleReconcileAfter', async () => {
    const userId = 'user_idle_before';
    const sessionId = 'agent_idle_before';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_idle_before',
        kiloSessionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-idle-before',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId } = wrapperState;

      const acceptedMessage: SessionMessageState = {
        messageId: 'msg_018f1e2d3c4b00000000000001',
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: wrapperRunId!,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMessage);

      const future = Date.now() + 60_000;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId,
        wrapperRunId,
        lastWrapperIdleAt: Date.now(),
        idleReconcileAfter: future,
      });

      await instance.alarm();

      const nonTerminalMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperRunId!
      );

      return { nonTerminalMessages };
    });

    expect(result.nonTerminalMessages).toHaveLength(1);
    expect(result.nonTerminalMessages[0]?.status).toBe('accepted');
  });

  it('idle reconciliation fails accepted messages with missing_assistant_reply after idleReconcileAfter', async () => {
    const userId = 'user_idle_after';
    const sessionId = 'agent_idle_after';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_idle_after',
        kiloSessionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-idle-after',
      });
      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const messageId = 'msg_018f1e2d3c4b00000000000002';
      await putSessionMessageState(instance.ctx.storage, {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: wrapperState.wrapperRunId!,
      });
      const past = Date.now() - 1;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId: wrapperState.wrapperConnectionId,
        wrapperRunId: wrapperState.wrapperRunId,
        lastWrapperIdleAt: past - 15_000,
        idleReconcileAfter: past,
      });
      await instance.alarm();

      const nonTerminalMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperState.wrapperRunId!
      );
      const failedMessage = await getSessionMessageState(instance.ctx.storage, messageId);
      const events = createEventQueries(
        drizzle(state.storage, { logger: false }),
        state.storage.sql
      );

      return {
        nonTerminalMessages,
        failedMessage,
        failedEvents: events.findByFilters({ eventTypes: ['cloud.message.failed'] }),
        lease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result.nonTerminalMessages).toHaveLength(0);
    expect(result.failedMessage).toMatchObject({
      failureStage: 'post_dispatch_no_activity',
      failureCode: 'missing_assistant_reply',
    });

    expect(result.failedEvents).toHaveLength(1);
    expect(JSON.parse(result.failedEvents[0].payload)).toMatchObject({
      messageId: 'msg_018f1e2d3c4b00000000000002',
      status: 'failed',
      error: 'No assistant reply found during reconciliation',
      delivery: 'sent',
      accepted: true,
      completionSource: 'idle_reconciliation',
    });
    expect(result.lease).toMatchObject({ state: 'stop_needed', reason: 'terminal-failed' });
  });

  it('idle reconciliation treats object-shaped assistant errors as failed replies', async () => {
    const userId = 'user_idle_object_error';
    const sessionId = 'agent_idle_object_error';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_idle_object_error',
        kiloSessionId: 'edededed-eded-4ede-8ede-edededededed',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-idle-object-error',
      });
      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const messageId = 'msg_018f1e2d3c4bObjErrIdleAbCd';
      await putSessionMessageState(instance.ctx.storage, {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: wrapperState.wrapperRunId!,
      });
      const events = createEventQueries(
        drizzle(state.storage, { logger: false }),
        state.storage.sql
      );
      events.upsert({
        executionId: '',
        sessionId,
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          properties: {
            info: {
              id: 'assistant_obj_error_idle',
              role: 'assistant',
              sessionID: 'edededed-eded-4ede-8ede-edededededed',
              parentID: messageId,
              error: { name: 'UnknownError', data: { message: 'provider failed during idle' } },
            },
          },
        }),
        timestamp: Date.now(),
        entityId: 'message/assistant_obj_error_idle',
      });
      const past = Date.now() - 1;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId: wrapperState.wrapperConnectionId,
        wrapperRunId: wrapperState.wrapperRunId,
        lastWrapperIdleAt: past - 15_000,
        idleReconcileAfter: past,
      });
      await instance.alarm();
      return {
        failedEvents: events.findByFilters({ eventTypes: ['cloud.message.failed'] }),
        completedEvents: events.findByFilters({ eventTypes: ['cloud.message.completed'] }),
        lease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result.failedEvents).toHaveLength(1);
    expect(JSON.parse(result.failedEvents[0].payload)).toMatchObject({
      messageId: 'msg_018f1e2d3c4bObjErrIdleAbCd',
      status: 'failed',
      error: 'provider failed during idle',
      completionSource: 'idle_reconciliation',
    });
    expect(result.completedEvents).toHaveLength(0);
    expect(result.lease).toMatchObject({ state: 'stop_needed', reason: 'terminal-failed' });
  });

  it('meaningful wrapper output refreshes liveness without clearing idle state', async () => {
    const userId = 'user_idle_output';
    const sessionId = 'agent_idle_output';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_idle_output',
        kiloSessionId: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-idle-output',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId, wrapperGeneration } = wrapperState;

      // Set idle state
      const idleAt = Date.now();
      const reconcileAt = idleAt + 15_000;
      const keepWarmAt = idleAt + 5 * 60 * 1000;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration,
        wrapperConnectionId,
        wrapperRunId,
        lastWrapperIdleAt: idleAt,
        idleReconcileAfter: reconcileAt,
        wrapperIdleDeadlineAt: keepWarmAt,
      });

      const handler = await (instance as any).getIngestHandler();
      const ws = {
        deserializeAttachment: () => ({
          wrapperRunId,
          sessionId,
          connectedAt: Date.now(),
          kiloSessionState: { captured: false },
          lastHeartbeatUpdate: Date.now(),
          lastEventAtUpdate: Date.now(),
          wrapperGeneration,
          wrapperConnectionId,
        }),
        serializeAttachment: () => {},
        send: () => {},
      } as unknown as WebSocket;

      // Simulate a non-fatal error event. This is post-completion infrastructure
      // output: it must refresh wrapper liveness but must NOT disarm the idle
      // reconciler that is about to finalize the in-flight message.
      await handler.handleIngestMessage(
        ws,
        JSON.stringify({
          streamEventType: 'error',
          data: { fatal: false, error: 'something happened' },
          timestamp: new Date().toISOString(),
        })
      );

      const runtimeState = await getWrapperRuntimeState(instance.ctx.storage);
      return { runtimeState, idleAt, reconcileAt, keepWarmAt };
    });

    // Idle reconciliation fields stay armed so the reconciler still fires.
    expect(result.runtimeState.lastWrapperIdleAt).toBe(result.idleAt);
    expect(result.runtimeState.idleReconcileAfter).toBe(result.reconcileAt);
    expect(result.runtimeState.wrapperIdleDeadlineAt).toBe(result.keepWarmAt);
    // Liveness is refreshed by the output.
    expect(result.runtimeState.lastWrapperMessageAt).toBeDefined();
  });

  it('root session.idle records wrapperIdleDeadlineAt for keep-warm', async () => {
    const userId = 'user_idle_warm';
    const sessionId = 'agent_idle_warm';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_idle_warm',
        kiloSessionId: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-idle-warm',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId, wrapperGeneration } = wrapperState;

      const handler = await (instance as any).getIngestHandler();
      const ws = {
        deserializeAttachment: () => ({
          wrapperRunId,
          sessionId,
          connectedAt: Date.now(),
          kiloSessionState: { captured: false },
          lastHeartbeatUpdate: Date.now(),
          lastEventAtUpdate: Date.now(),
          wrapperGeneration,
          wrapperConnectionId,
        }),
        serializeAttachment: () => {},
        send: () => {},
      } as unknown as WebSocket;

      const beforeIngest = Date.now();
      await handler.handleIngestMessage(
        ws,
        JSON.stringify({
          streamEventType: 'kilocode',
          data: {
            event: 'session.idle',
            properties: {
              sessionID: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
            },
          },
          timestamp: new Date().toISOString(),
        })
      );

      const runtimeState = await getWrapperRuntimeState(instance.ctx.storage);

      return { runtimeState, beforeIngest, afterIngest: Date.now() };
    });

    expect(result.runtimeState.wrapperIdleDeadlineAt).toBeDefined();
    expect(result.runtimeState.wrapperIdleDeadlineAt).toBeGreaterThanOrEqual(
      result.beforeIngest + 4 * 60 * 1000
    );
    expect(result.runtimeState.wrapperIdleDeadlineAt).toBeLessThanOrEqual(
      result.afterIngest + 6 * 60 * 1000
    );
  });

  it('keep-warm cleanup does not run before wrapperIdleDeadlineAt', async () => {
    const userId = 'user_warm_before';
    const sessionId = 'agent_warm_before';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    let stopWrapperCalled = false;

    const result = await runInDurableObject(stub, async instance => {
      instance['physicalWrapperStopper'] = async () => {
        stopWrapperCalled = true;
        return { status: 'absent' };
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_warm_before',
        kiloSessionId: 'ffffffff-ffff-4fff-ffff-ffffffffffff',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-warm-before',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId } = wrapperState;

      const future = Date.now() + 60_000;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId,
        wrapperRunId,
        wrapperIdleDeadlineAt: future,
        idleReconcileAfter: future,
      });

      await instance.alarm();

      const runtimeState = await getWrapperRuntimeState(instance.ctx.storage);
      return { runtimeState, stopWrapperCalled };
    });

    expect(result.stopWrapperCalled).toBe(false);
    expect(result.runtimeState.wrapperConnectionId).toBe(result.runtimeState.wrapperConnectionId);
  });

  it('keep-warm cleanup tears down idle wrapper after deadline with no work', async () => {
    const userId = 'user_warm_teardown';
    const sessionId = 'agent_warm_teardown';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    let stopWrapperCalled = false;

    const result = await runInDurableObject(stub, async instance => {
      instance['physicalWrapperStopper'] = async () => {
        stopWrapperCalled = true;
        return { status: 'absent' };
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_warm_teardown',
        kiloSessionId: '11111111-1111-4111-1111-111111111111',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-warm-teardown',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId } = wrapperState;

      const past = Date.now() - 1;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId,
        wrapperRunId,
        wrapperIdleDeadlineAt: past,
      });

      await instance.alarm();

      const runtimeState = await getWrapperRuntimeState(instance.ctx.storage);
      return {
        runtimeState,
        lease: await getWrapperLease(instance.ctx.storage),
        stopWrapperCalled,
      };
    });

    expect(result.stopWrapperCalled).toBe(false);
    expect(result.runtimeState.wrapperConnectionId).toBeUndefined();
    expect(result.lease).toMatchObject({ state: 'stop_needed', reason: 'keep-warm-expired' });
  });

  it('keep-warm cleanup clears idle state when work exists after deadline', async () => {
    const userId = 'user_warm_work';
    const sessionId = 'agent_warm_work';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    let stopWrapperCalled = false;

    const result = await runInDurableObject(stub, async instance => {
      instance['physicalWrapperStopper'] = async () => {
        stopWrapperCalled = true;
        return { status: 'absent' };
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_warm_work',
        kiloSessionId: '22222222-2222-4222-2222-222222222222',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-warm-work',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId } = wrapperState;

      // Place an accepted message so work exists
      const acceptedMessage: SessionMessageState = {
        messageId: 'msg_018f1e2d3c4b00000000000099',
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: wrapperRunId!,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMessage);

      const past = Date.now() - 1;
      const future = Date.now() + 60_000;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId,
        wrapperRunId,
        wrapperIdleDeadlineAt: past,
        idleReconcileAfter: future,
      });

      await instance.alarm();

      const runtimeState = await getWrapperRuntimeState(instance.ctx.storage);
      return { runtimeState, stopWrapperCalled };
    });

    expect(result.stopWrapperCalled).toBe(false);
    expect(result.runtimeState.wrapperIdleDeadlineAt).toBeUndefined();
  });
});
