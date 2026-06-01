/**
 * Integration test for the executeDirectly catch-block fix in CloudAgentSession.
 *
 * When the orchestrator throws during delivery, message lifecycle state must
 * record the failed delivery path and any required callback notification before
 * the admission/drain boundary reports failure.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import type { FencedWrapperDispatchRequest } from '../../../src/execution/types.js';
import { listPendingSessionMessages } from '../../../src/session/pending-messages.js';
import {
  getWrapperLease,
  getWrapperRuntimeState,
  recordWrapperPong,
  allocateWrapperRuntimeState,
  recordWrapperAcceptedMessage,
} from '../../../src/session/wrapper-runtime-state.js';
import {
  listNonTerminalAcceptedMessages,
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import { queueUserMessageInput, registerReadySession } from '../../helpers/session-setup.js';

describe('executeDirectly failure handling', () => {
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

  it('wrapper heartbeat does not reset the no-output deadline', async () => {
    const userId = 'user_liveness_heartbeat';
    const sessionId = 'agent_liveness_heartbeat';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_liveness_heartbeat',
        kiloSessionId: 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-liveness-heartbeat',
      });

      const originalDeadline = Date.now() + 5_000;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_heartbeat',
        wrapperRunId: 'wr_heartbeat',
        noOutputDeadlineAt: originalDeadline,
        nextPingAt: Date.now() + 60_000,
      });

      const handler = await instance['getIngestHandler']();
      const ws = {
        deserializeAttachment: () => ({
          wrapperRunId: 'wr_heartbeat',
          connectedAt: Date.now(),
          kiloSessionState: { captured: false },
          lastHeartbeatUpdate: 0,
          lastEventAtUpdate: 0,
          wrapperGeneration: 1,
          wrapperConnectionId: 'conn_heartbeat',
        }),
        serializeAttachment: () => {},
        send: () => {},
      } as unknown as WebSocket;

      await handler.handleIngestMessage(
        ws,
        JSON.stringify({
          streamEventType: 'heartbeat',
          data: {},
          timestamp: new Date().toISOString(),
        })
      );

      const wrapperRuntimeState = await getWrapperRuntimeState(instance.ctx.storage);
      return { wrapperRuntimeState, originalDeadline };
    });

    // Heartbeats are keepalives, not forward progress - they must not push the
    // no-output deadline forward, otherwise a stalled wrapper sending only
    // heartbeats would never be caught.
    expect(result.wrapperRuntimeState.noOutputDeadlineAt).toBe(result.originalDeadline);
  });

  it('meaningful wrapper output pushes the no-output deadline forward', async () => {
    const userId = 'user_liveness_refresh';
    const sessionId = 'agent_liveness_refresh';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_liveness_refresh',
        kiloSessionId: 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-liveness-refresh',
      });

      const staleDeadline = Date.now() + 1_000;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_refresh',
        wrapperRunId: 'wr_refresh',
        noOutputDeadlineAt: staleDeadline,
        nextPingAt: Date.now() + 60_000,
      });

      const handler = await instance['getIngestHandler']();
      const ws = {
        deserializeAttachment: () => ({
          wrapperRunId: 'wr_refresh',
          connectedAt: Date.now(),
          kiloSessionState: { captured: false },
          lastHeartbeatUpdate: 0,
          lastEventAtUpdate: 0,
          wrapperGeneration: 1,
          wrapperConnectionId: 'conn_refresh',
        }),
        serializeAttachment: () => {},
        send: () => {},
      } as unknown as WebSocket;

      await handler.handleIngestMessage(
        ws,
        JSON.stringify({
          streamEventType: 'kilocode',
          data: { event: 'session.status' },
          timestamp: new Date().toISOString(),
        })
      );

      const wrapperRuntimeState = await getWrapperRuntimeState(instance.ctx.storage);
      return { wrapperRuntimeState, staleDeadline };
    });

    expect(result.wrapperRuntimeState.noOutputDeadlineAt).toBeGreaterThan(result.staleDeadline);
  });

  it('queued flush pre-start failure retries cleanly with the original execution and message ids', async () => {
    const userId = 'user_exec_direct_fail';
    const sessionId = 'agent_exec_direct_fail';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      let attemptCount = 0;
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          attemptCount += 1;
          if (attemptCount === 1) {
            throw new Error('Sandbox connect failed');
          }

          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_retry_success' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_exec_direct_fail',
        kiloSessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-direct-fail',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'do some work',
        messageId: 'msg_018f1e2d3c4bFailMsgAbCdEfG',
      });

      const startResult = await instance.admitSubmittedMessage(request);
      const pendingAfterStart = await listPendingSessionMessages(instance.ctx.storage);

      await instance.alarm();

      const pendingAfterAlarm = await listPendingSessionMessages(instance.ctx.storage);
      const executionsAfterFirstAlarm = await instance.getExecutions();
      const wrapperRuntimeState = await getWrapperRuntimeState(instance.ctx.storage);
      const wrapperLeaseAfterFailure = await getWrapperLease(instance.ctx.storage);

      await instance.alarm();
      const wrapperLeaseAfterCleanup = await getWrapperLease(instance.ctx.storage);
      const retriableMessage = pendingAfterAlarm[0];
      if (retriableMessage) {
        await instance.ctx.storage.put('pending_message:0000000000000001:retry-fix', {
          version: 2,
          intent: retriableMessage.intent,
          delivery: {
            queuedAt: retriableMessage.createdAt,
            flushAttempts: retriableMessage.flushAttempts,
            nextFlushAttemptAt: Date.now() - 1,
            lastFlushError: retriableMessage.lastFlushError,
          },
          callbackSnapshot: retriableMessage.callbackSnapshot,
        });
        await instance.ctx.storage.delete(
          'pending_message:0000000000000001:msg_018f1e2d3c4bFailMsgAbCdEfG'
        );
      }

      await instance.alarm();

      const acceptedMessages = await listNonTerminalAcceptedMessages(instance.ctx.storage);
      const pendingAfterRetry = await listPendingSessionMessages(instance.ctx.storage);
      const executionsAfterRetry = await instance.getExecutions();

      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const retryEvents = eventQueries.findByFilters({});

      return {
        startResult,
        attemptCount,
        pendingAfterStart,
        pendingAfterAlarm,
        pendingAfterRetry,
        executionsAfterFirstAlarm,
        executionsAfterRetry,
        acceptedMessages,
        wrapperRuntimeState,
        wrapperLeaseAfterFailure,
        wrapperLeaseAfterCleanup,
        retryEvents,
      };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;
    expect(result.startResult.outcome).toBe('queued');
    expect(result.pendingAfterStart.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bFailMsgAbCdEfG',
    ]);

    expect(result.pendingAfterAlarm.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bFailMsgAbCdEfG',
    ]);
    expect(result.pendingAfterAlarm[0]?.executionId).toBeUndefined();
    expect(result.pendingAfterAlarm[0]?.lastFlushError).toBe('Sandbox connect failed');
    expect(result.executionsAfterFirstAlarm).toEqual([]);
    expect(result.wrapperRuntimeState.wrapperGeneration).toBe(2);
    expect(result.wrapperRuntimeState.wrapperConnectionId).toBeUndefined();
    expect(result.wrapperLeaseAfterFailure).toMatchObject({
      state: 'stop_needed',
      reason: 'startup-failed',
    });
    expect(result.wrapperLeaseAfterCleanup).toMatchObject({ state: 'none' });

    expect(result.attemptCount).toBe(2);
    expect(result.pendingAfterRetry).toHaveLength(0);
    expect(result.acceptedMessages).toHaveLength(1);
    expect(result.acceptedMessages[0]?.messageId).toBe('msg_018f1e2d3c4bFailMsgAbCdEfG');
    // New-path messages do not create execution metadata rows.
    expect(result.executionsAfterRetry).toHaveLength(0);
    expect(result.retryEvents.filter(event => event.stream_event_type === 'error')).toHaveLength(0);
  });
});

describe('handleWrapperTerminalEvent — new-path identity and message preservation', () => {
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

  it('wrapper complete does not clear wrapper runtime identity when accepted messages remain', async () => {
    const userId = 'user_wrapper_complete_identity';
    const sessionId = 'agent_wrapper_complete_identity';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_wrapper_complete_id',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-wrapper-complete-id',
      });

      // Allocate wrapper runtime state (new path — no executionId)
      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId } = wrapperState;

      // Store an accepted (non-terminal) session message state
      const acceptedMessage: SessionMessageState = {
        messageId: 'msg_018f1e2d3c4bWrpCmpAbCdEfGh',
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMessage);

      // Fire wrapper complete — with accepted non-terminal messages present
      await instance.handleWrapperTerminalEvent({
        wrapperRunId: wrapperRunId!,
        status: 'completed',
      });

      const wrapperRuntimeState = await getWrapperRuntimeState(instance.ctx.storage);
      const acceptedMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperRunId!
      );

      return { wrapperRuntimeState, wrapperConnectionId, acceptedMessages };
    });

    // Identity must NOT be cleared while accepted work remains
    expect(result.wrapperRuntimeState.wrapperConnectionId).toBe(result.wrapperConnectionId);
    // Accepted message must still be non-terminal
    expect(result.acceptedMessages).toHaveLength(1);
    expect(result.acceptedMessages[0]?.status).toBe('accepted');
  });

  // NOTE: Per Phase 6 (keep-warm cleanup), wrapper `complete` will eventually NOT clear
  // identity even when no accepted messages remain — keep-warm alarm cleanup owns that.
  // The current behavior (clearing when idle) is interim and will be superseded by Phase 6.
});

describe('new-path liveness without executionId', () => {
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

  it('schedules liveness deadlines for accepted messages and fails them on no-output timeout', async () => {
    const userId = 'user_newpath_liveness';
    const sessionId = 'agent_newpath_liveness';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_newpath_liveness',
        kiloSessionId: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-newpath-liveness',
      });

      // Allocate wrapper runtime state (new path — no executionId)
      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId } = wrapperState;

      // Store an accepted (non-terminal) session message state
      const acceptedMessage: SessionMessageState = {
        messageId: 'msg_018f1e2d3c4bnewlivabcdefgh',
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: wrapperRunId!,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMessage);

      // Set expired liveness deadlines — new path has no executionId
      const expiredAt = Date.now() - 1;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId,
        wrapperRunId,
        noOutputDeadlineAt: expiredAt,
        lastHeartbeatUpdate: expiredAt - 10 * 60_000,
      });

      await instance.alarm();

      const nonTerminalMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperRunId!
      );
      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const allEvents = eventQueries.findByFilters({});
      return {
        nonTerminalMessages,
        allEvents,
        wrapperRuntimeState: await getWrapperRuntimeState(instance.ctx.storage),
      };
    });

    // Message must be terminalized as failed
    expect(result.nonTerminalMessages).toHaveLength(0);

    // A cloud.message.failed event must be persisted
    const failedEvents = result.allEvents.filter(
      event => event.stream_event_type === 'cloud.message.failed'
    );
    expect(failedEvents).toHaveLength(1);
    const failedPayload = JSON.parse(failedEvents[0].payload);
    expect(failedPayload).toMatchObject({
      messageId: 'msg_018f1e2d3c4bnewlivabcdefgh',
      status: 'failed',
      error: 'Wrapper accepted the message but produced no output',
      delivery: 'sent',
      accepted: true,
    });

    // Liveness deadlines must be cleared
    expect(result.wrapperRuntimeState.noOutputDeadlineAt).toBeUndefined();
    expect(result.wrapperRuntimeState.pingDeadlineAt).toBeUndefined();
    expect(result.wrapperRuntimeState.nextPingAt).toBeUndefined();
  });

  it('schedules liveness deadlines for accepted messages and fails them on ping timeout', async () => {
    const userId = 'user_newpath_ping';
    const sessionId = 'agent_newpath_ping';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_newpath_ping',
        kiloSessionId: 'ffffffff-ffff-4fff-ffff-ffffffffffff',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-newpath-ping',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const { wrapperRunId, wrapperConnectionId } = wrapperState;

      const acceptedMessage: SessionMessageState = {
        messageId: 'msg_018f1e2d3c4bnewpingabcdefg',
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: wrapperRunId!,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMessage);

      const expiredAt = Date.now() - 1;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId,
        wrapperRunId,
        pingDeadlineAt: expiredAt,
        lastHeartbeatUpdate: expiredAt - 10 * 60_000,
      });

      await instance.alarm();

      const nonTerminalMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperRunId!
      );
      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const allEvents = eventQueries.findByFilters({});
      return {
        nonTerminalMessages,
        allEvents,
        wrapperRuntimeState: await getWrapperRuntimeState(instance.ctx.storage),
      };
    });

    expect(result.nonTerminalMessages).toHaveLength(0);

    const failedEvents = result.allEvents.filter(
      event => event.stream_event_type === 'cloud.message.failed'
    );
    expect(failedEvents).toHaveLength(1);
    const failedPayload = JSON.parse(failedEvents[0].payload);
    expect(failedPayload).toMatchObject({
      messageId: 'msg_018f1e2d3c4bnewpingabcdefg',
      status: 'failed',
      error: 'Wrapper did not respond to liveness ping',
      delivery: 'sent',
      accepted: true,
    });

    expect(result.wrapperRuntimeState.pingDeadlineAt).toBeUndefined();
    expect(result.wrapperRuntimeState.nextPingAt).toBeUndefined();
  });
});

describe('hot delivery failure preserves existing wrapper identity', () => {
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

  it('failed hot delivery does not clear wrapper identity for already accepted work', async () => {
    const userId = 'user_hot_fail_identity';
    const sessionId = 'agent_hot_fail_identity';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          throw new Error('Sandbox connect failed');
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_hot_fail_identity',
        kiloSessionId: '11111111-2222-4111-1111-111111111111',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-hot-fail-identity',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const originalRunId = wrapperState.wrapperRunId!;
      const originalConnectionId = wrapperState.wrapperConnectionId!;
      const originalGeneration = wrapperState.wrapperGeneration;
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_hot_failure', instanceGeneration: 1 },
      });
      instance['physicalWrapperObserver'] = async () => ({
        status: 'present',
        observed: [
          {
            representation: 'process',
            id: 'wrapper-hot-failure',
            port: 5000,
            instanceId: 'instance_hot_failure',
            instanceGeneration: 1,
          },
        ],
      });

      const acceptedMsg: SessionMessageState = {
        messageId: 'msg_018f1e2d3c4bHotFailAccAbCd',
        status: 'accepted',
        prompt: 'running task',
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: originalRunId,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMsg);

      await recordWrapperAcceptedMessage(
        instance.ctx.storage,
        wrapperState,
        Date.now() + 30 * 60_000,
        Date.now() + 60_000
      );

      await instance.ctx.storage.put('wrapper_runtime_state', {
        ...(await getWrapperRuntimeState(instance.ctx.storage)),
        lastWrapperMessageAt: Date.now(),
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'hot follow-up that will fail',
        messageId: 'msg_018f1e2d3c4bHotFailMsgAbCd',
      });

      await instance.admitSubmittedMessage(request);

      await instance.alarm();

      const wrapperRuntimeState = await getWrapperRuntimeState(instance.ctx.storage);
      const acceptedMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        originalRunId
      );

      return {
        wrapperRuntimeState,
        originalRunId,
        originalConnectionId,
        originalGeneration,
        acceptedMessages,
      };
    });

    expect(result.wrapperRuntimeState.wrapperRunId).toBe(result.originalRunId);
    expect(result.wrapperRuntimeState.wrapperConnectionId).toBe(result.originalConnectionId);
    expect(result.wrapperRuntimeState.wrapperGeneration).toBe(result.originalGeneration);
    expect(result.acceptedMessages).toHaveLength(1);
    expect(result.acceptedMessages[0]?.messageId).toBe('msg_018f1e2d3c4bHotFailAccAbCd');
    expect(result.acceptedMessages[0]?.status).toBe('accepted');
  });

  it('failed cold delivery fences its run and retains physical cleanup responsibility', async () => {
    const userId = 'user_cold_fail_identity';
    const sessionId = 'agent_cold_fail_identity';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          throw new Error('Sandbox connect failed');
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_cold_fail_identity',
        kiloSessionId: '33333333-4444-4333-3333-333333333333',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-cold-fail-identity',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'cold delivery that will fail',
        messageId: 'msg_018f1e2d3c4bColdFailMsAbCd',
      });

      await instance.admitSubmittedMessage(request);

      const preAlarmState = await getWrapperRuntimeState(instance.ctx.storage);

      await instance.alarm();

      const wrapperRuntimeState = await getWrapperRuntimeState(instance.ctx.storage);
      const wrapperLease = await getWrapperLease(instance.ctx.storage);

      return {
        preAlarmState,
        wrapperRuntimeState,
        wrapperLease,
      };
    });

    expect(result.wrapperRuntimeState.wrapperConnectionId).toBeUndefined();
    expect(result.wrapperRuntimeState.wrapperRunId).toBeUndefined();
    expect(result.wrapperRuntimeState.wrapperGeneration).toBeGreaterThan(
      result.preAlarmState.wrapperGeneration
    );
    expect(result.wrapperLease).toMatchObject({
      state: 'stop_needed',
      reason: 'startup-failed',
    });
  });
});
