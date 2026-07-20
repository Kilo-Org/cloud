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
  getSandboxRecoveryState,
  getWrapperLease,
  getWrapperRuntimeState,
  recordWrapperPong,
  allocateWrapperRuntimeState,
  recordWrapperAcceptedMessage,
} from '../../../src/session/wrapper-runtime-state.js';
import type { CallbackJob } from '../../../src/callbacks/types.js';
import { deriveSharedSandboxId } from '../../../src/sandbox-id.js';
import { SHARED_SANDBOX_FAILOVER_SUFFIX } from '../../../src/shared-sandbox-route.js';
import { serializeSessionMetadata } from '../../../src/persistence/session-metadata.js';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import {
  getSessionMessageState,
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

  it('wrapper complete reconciles still-accepted messages instead of stranding them', async () => {
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

      const messageId = 'msg_018f1e2d3c4bWrpCmpAbCdEfGh';
      // Store an accepted (non-terminal) session message state
      const acceptedMessage: SessionMessageState = {
        messageId,
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMessage);

      // Fire wrapper complete with an accepted non-terminal message present.
      // `complete` is the race-free terminal signal, so the message must be
      // settled here rather than left stranded (which would hang the callback).
      // This session has no kiloSessionId, so no assistant reply can be found
      // and the message settles as failed (missing_assistant_reply).
      await instance.handleWrapperTerminalEvent({
        wrapperRunId: wrapperRunId!,
        status: 'completed',
        messageIds: [messageId],
      });

      const wrapperRuntimeState = await getWrapperRuntimeState(instance.ctx.storage);
      const acceptedMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperRunId!
      );
      const settledMessage = await getSessionMessageState(instance.ctx.storage, messageId);

      return { wrapperRuntimeState, wrapperConnectionId, acceptedMessages, settledMessage };
    });

    // The message is settled rather than left accepted.
    expect(result.acceptedMessages).toHaveLength(0);
    expect(result.settledMessage).toMatchObject({
      status: 'failed',
      failureCode: 'missing_assistant_reply',
      completionSource: 'idle_reconciliation',
    });
    // Identity is released once the run has no remaining accepted work.
    expect(result.wrapperRuntimeState.wrapperConnectionId).toBeUndefined();
  });
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
      error: 'Agent wrapper produced no output',
      delivery: 'sent',
      accepted: true,
      failure: {
        stage: 'post_dispatch_no_activity',
        code: 'wrapper_no_output',
        message: 'Agent wrapper produced no output',
      },
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
      error: 'Agent wrapper stopped responding',
      delivery: 'sent',
      accepted: true,
      failure: {
        stage: 'post_dispatch_no_activity',
        code: 'wrapper_ping_timeout',
        message: 'Agent wrapper stopped responding',
      },
    });

    expect(result.wrapperRuntimeState.pingDeadlineAt).toBeUndefined();
    expect(result.wrapperRuntimeState.nextPingAt).toBeUndefined();
  });

  it('delivers only the queued follow-up on a fresh fence after ping-timeout recovery', async () => {
    const userId = 'user_ping_recovery';
    const sessionId = 'agent_ping_recovery';
    const acceptedMessageId = 'msg_018f1e2d3c4bPingOldAbCdEfG';
    const followUpMessageId = 'msg_018f1e2d3c4bPingNewAbCdEfG';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const deliveredPlans: FencedWrapperDispatchRequest[] = [];
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          deliveredPlans.push(plan);
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_ping_recovery' };
        },
      };
      instance['physicalWrapperStopper'] = async () => ({ status: 'absent' });

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_ping_recovery',
        kiloSessionId: '12121212-1212-4121-8121-121212121212',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-ping-recovery',
      });

      const { state: originalWrapper } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const originalRunId = originalWrapper.wrapperRunId!;
      const originalConnectionId = originalWrapper.wrapperConnectionId!;
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_ping_recovery', instanceGeneration: 1 },
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: acceptedMessageId,
        status: 'accepted',
        prompt: 'work accepted by the old wrapper',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: originalRunId,
      });

      const admission = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queued follow-up',
          messageId: followUpMessageId,
        })
      );
      expect(admission.success).toBe(true);

      const expiredAt = Date.now() - 1;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: originalWrapper.wrapperGeneration,
        wrapperConnectionId: originalConnectionId,
        wrapperRunId: originalRunId,
        pingDeadlineAt: expiredAt,
        lastHeartbeatUpdate: expiredAt - 10 * 60_000,
      });

      await instance.alarm();

      const db = drizzle(state.storage, { logger: false });
      const allEvents = createEventQueries(db, state.storage.sql).findByFilters({});
      const supervisor = instance['getWrapperSupervisor']();
      return {
        deliveredPlans,
        acceptedMessage: await getSessionMessageState(instance.ctx.storage, acceptedMessageId),
        followUpMessage: await getSessionMessageState(instance.ctx.storage, followUpMessageId),
        pendingMessages: await listPendingSessionMessages(instance.ctx.storage),
        wrapperRuntimeState: await getWrapperRuntimeState(instance.ctx.storage),
        wrapperLease: await getWrapperLease(instance.ctx.storage),
        failedEvents: allEvents.filter(event => event.stream_event_type === 'cloud.message.failed'),
        staleReconnect: await supervisor.checkReconnect({
          wrapperRunId: originalRunId,
          wrapperGeneration: originalWrapper.wrapperGeneration,
          wrapperConnectionId: originalConnectionId,
        }),
        originalRunId,
        originalGeneration: originalWrapper.wrapperGeneration,
      };
    });

    expect(result.acceptedMessage).toMatchObject({
      status: 'failed',
      failureCode: 'wrapper_ping_timeout',
    });
    expect(result.followUpMessage).toMatchObject({
      status: 'accepted',
    });
    expect(result.pendingMessages).toHaveLength(0);
    expect(result.deliveredPlans).toHaveLength(1);
    expect(result.deliveredPlans[0].turn.messageId).toBe(followUpMessageId);
    expect(result.deliveredPlans[0].wrapper.fence.wrapperRunId).not.toBe(result.originalRunId);
    expect(result.deliveredPlans[0].wrapper.fence.wrapperGeneration).toBeGreaterThan(
      result.originalGeneration
    );
    expect(result.wrapperRuntimeState.wrapperRunId).toBe(
      result.deliveredPlans[0].wrapper.fence.wrapperRunId
    );
    expect(result.wrapperLease).toMatchObject({ state: 'owns_wrapper' });
    expect(result.failedEvents).toHaveLength(1);
    expect(result.staleReconnect).toEqual({ accepted: false, reason: 'stale-wrapper-run' });
  });

  it('defers terminal effects while physical cleanup still fences queued recovery', async () => {
    const userId = 'user_ping_cleanup_hold';
    const sessionId = 'agent_ping_cleanup_hold';
    const acceptedMessageId = 'msg_018f1e2d3c4bPingHoldOldAbC';
    const followUpMessageId = 'msg_018f1e2d3c4bPingHoldNewAbC';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_ping_cleanup_hold',
        kiloSessionId: '34343434-3434-4343-8343-343434343434',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-ping-cleanup-hold',
      });

      const { state: originalWrapper } = await allocateWrapperRuntimeState(instance.ctx.storage);
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_ping_cleanup_hold', instanceGeneration: 1 },
      });
      instance['physicalWrapperStopper'] = async () => ({
        status: 'still-present',
        observed: [],
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: acceptedMessageId,
        status: 'accepted',
        prompt: 'work accepted by the old wrapper',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: originalWrapper.wrapperRunId!,
      });
      const admission = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queued follow-up',
          messageId: followUpMessageId,
        })
      );
      expect(admission.success).toBe(true);

      const expiredAt = Date.now() - 1;
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: originalWrapper.wrapperGeneration,
        wrapperConnectionId: originalWrapper.wrapperConnectionId!,
        wrapperRunId: originalWrapper.wrapperRunId!,
        pingDeadlineAt: expiredAt,
        lastHeartbeatUpdate: expiredAt - 10 * 60_000,
      });

      await instance.alarm();

      const db = drizzle(state.storage, { logger: false });
      const allEvents = createEventQueries(db, state.storage.sql).findByFilters({});
      return {
        acceptedMessage: await getSessionMessageState(instance.ctx.storage, acceptedMessageId),
        pendingMessages: await listPendingSessionMessages(instance.ctx.storage),
        wrapperLease: await getWrapperLease(instance.ctx.storage),
        failedEvents: allEvents.filter(event => event.stream_event_type === 'cloud.message.failed'),
      };
    });

    expect(result.acceptedMessage).toMatchObject({
      status: 'failed',
      failureCode: 'wrapper_ping_timeout',
      terminalEffects: {
        event: 'pending',
        push: { disposition: 'pending' },
      },
    });
    expect(result.pendingMessages).toEqual([
      expect.objectContaining({ messageId: followUpMessageId }),
    ]);
    expect(result.wrapperLease).toMatchObject({
      state: 'stop_needed',
      reason: 'unhealthy-wrapper',
      attempts: 1,
    });
    expect(result.failedEvents).toHaveLength(0);
  });

  it('repairs terminal effects during exhausted cleanup and resumes queued work after isolated recovery', async () => {
    const userId = 'user_exhausted_isolated_recovery';
    const sessionId = 'agent_exhausted_isolated_recovery';
    const acceptedMessageId = 'msg_018f1e2d3c4bExhaustOldAbCd';
    const unrelatedCallbackMessageId = 'msg_018f1e2d3c4bExhaustCbAbCdE';
    const followUpMessageId = 'msg_018f1e2d3c4bExhaustNewAbCd';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const callbackJobs: CallbackJob[] = [];
      (
        instance as unknown as {
          env: { CALLBACK_QUEUE: { send(job: CallbackJob): Promise<void> } };
        }
      ).env.CALLBACK_QUEUE = {
        send: async job => {
          callbackJobs.push(job);
        },
      };
      const deliveredPlans: FencedWrapperDispatchRequest[] = [];
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          deliveredPlans.push(plan);
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_exhausted_recovery' };
        },
      };
      let destroyAttempts = 0;
      instance['postExhaustionSandboxDestroyer'] = async () => {
        destroyAttempts += 1;
        if (destroyAttempts === 1) throw new Error('sandbox delete temporarily unavailable');
      };

      const callbackTarget = { url: 'https://example.com/exhausted-recovery' };
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_exhausted_isolated_recovery',
        kiloSessionId: '56565656-5656-4656-8656-565656565656',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-exhausted-recovery',
        sandboxId: 'ses-abcdef',
        callbackTarget,
      });

      await instance.ctx.storage.put('wrapper_runtime_state', { wrapperGeneration: 4 });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'stop_needed',
        nextInstanceGeneration: 5,
        target: { kind: 'session' },
        reason: 'unhealthy-wrapper',
        requestedAt: 100,
        nextAttemptAt: 3_153_600_000_100,
        attempts: 5,
        lastError: 'wrapper remains present',
        exhaustedAt: 100,
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: acceptedMessageId,
        status: 'accepted',
        prompt: 'accepted by the failed wrapper',
        createdAt: 1,
        acceptedAt: 2,
        wrapperRunId: 'wr_exhausted_old',
        callbackRequired: true,
        callbackTarget,
      });
      await instance['getMessageSettlementOutbox']().persistTerminalTransition(
        acceptedMessageId,
        {
          kind: 'failed',
          reason: 'wrapper_failure',
          error: 'Wrapper liveness ping timed out',
          completionSource: 'wrapper_failure',
          failureStage: 'post_dispatch_no_activity',
          failureCode: 'wrapper_ping_timeout',
        },
        { allowIdleBatchWithoutObservedIdle: true }
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId: unrelatedCallbackMessageId,
        status: 'failed',
        prompt: 'unrelated callback retry',
        createdAt: 1,
        terminalAt: 2,
        failureReason: 'delivery_failure',
        completionSource: 'delivery_failure',
        callbackRequired: true,
        callbackTarget,
        callbackAttempts: 1,
        callbackRetryAt: 0,
        terminalEffects: {
          event: 'accounted',
          callback: { disposition: 'accounted', allowWithoutObservedIdle: true },
          push: { disposition: 'accounted' },
        },
      });
      await instance.ctx.storage.put('idle_batch_callback:unrelated-retry', {
        batchId: 'unrelated-retry',
        createdAt: 1,
        updatedAt: 2,
        representativeMessageId: unrelatedCallbackMessageId,
        finalizedAt: 2,
      });
      const admission = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queued follow-up',
          messageId: followUpMessageId,
        })
      );
      expect(admission.success).toBe(true);

      await instance.alarm();

      const db = drizzle(state.storage, { logger: false });
      const eventsAfterFailure = createEventQueries(db, state.storage.sql).findByFilters({});
      const messageAfterFailure = await getSessionMessageState(
        instance.ctx.storage,
        acceptedMessageId
      );
      const pendingAfterFailure = await listPendingSessionMessages(instance.ctx.storage);
      const recoveryAfterFailure = await getSandboxRecoveryState(instance.ctx.storage);
      expect(pendingAfterFailure).toEqual([
        expect.objectContaining({ messageId: followUpMessageId }),
      ]);
      expect(messageAfterFailure?.terminalEffects).toMatchObject({
        event: 'accounted',
        callback: { disposition: 'accounted' },
      });
      expect(
        eventsAfterFailure.filter(event => event.stream_event_type === 'cloud.message.failed')
      ).toHaveLength(1);
      expect(callbackJobs.map(job => job.payload.messageId).sort()).toEqual(
        [acceptedMessageId, unrelatedCallbackMessageId].sort()
      );
      expect(recoveryAfterFailure?.postExhaustionRecovery).toMatchObject({
        kind: 'isolated-destroy',
        attempts: 1,
        lastError: 'sandbox delete temporarily unavailable',
      });

      if (!recoveryAfterFailure?.postExhaustionRecovery) {
        throw new Error('Expected persisted sandbox recovery');
      }
      await instance.ctx.storage.put('sandbox_recovery_state', {
        ...recoveryAfterFailure,
        postExhaustionRecovery: {
          ...recoveryAfterFailure.postExhaustionRecovery,
          nextAttemptAt: 0,
        },
      });
      await instance.alarm();

      return {
        callbackJobs,
        deliveredPlans,
        destroyAttempts,
        acceptedMessage: await getSessionMessageState(instance.ctx.storage, acceptedMessageId),
        followUpMessage: await getSessionMessageState(instance.ctx.storage, followUpMessageId),
        pendingMessages: await listPendingSessionMessages(instance.ctx.storage),
        wrapperLease: await getWrapperLease(instance.ctx.storage),
        events: createEventQueries(db, state.storage.sql).findByFilters({}),
      };
    });

    expect(result.destroyAttempts).toBe(2);
    expect(result.acceptedMessage).toMatchObject({
      status: 'failed',
      wrapperRunId: 'wr_exhausted_old',
    });
    expect(result.followUpMessage).toMatchObject({ status: 'accepted' });
    expect(result.pendingMessages).toHaveLength(0);
    expect(result.deliveredPlans).toHaveLength(1);
    expect(result.deliveredPlans[0].turn.messageId).toBe(followUpMessageId);
    expect(result.deliveredPlans[0].wrapper.fence.wrapperGeneration).toBeGreaterThan(4);
    expect(result.wrapperLease).toMatchObject({ state: 'owns_wrapper' });
    expect(result.callbackJobs.map(job => job.payload.messageId).sort()).toEqual(
      [acceptedMessageId, unrelatedCallbackMessageId].sort()
    );
    expect(
      result.events.filter(event => event.stream_event_type === 'cloud.message.failed')
    ).toHaveLength(1);
  });

  it('moves only the exhausted shared session to failover before queued delivery resumes', async () => {
    const routeKey = `usr-${'9'.repeat(48)}` as const;
    const replacementSandboxId = await deriveSharedSandboxId(
      routeKey,
      SHARED_SANDBOX_FAILOVER_SUFFIX
    );
    const affectedUserId = 'user_exhausted_shared_recovery';
    const affectedSessionId = 'agent_exhausted_shared_recovery';
    const otherUserId = 'user_exhausted_shared_other';
    const otherSessionId = 'agent_exhausted_shared_other';
    const followUpMessageId = 'msg_018f1e2d3c4bSharedNewAbCdE';
    const affectedStub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${affectedUserId}:${affectedSessionId}`)
    );
    const otherStub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${otherUserId}:${otherSessionId}`)
    );

    const installSharedMetadata = async (instance: CloudAgentSession) => {
      const metadata = await instance.getMetadata();
      if (!metadata?.workspace) throw new Error('Expected ready workspace metadata');
      await instance.ctx.storage.put(
        'metadata',
        serializeSessionMetadata({
          ...metadata,
          workspace: {
            ...metadata.workspace,
            sandboxId: routeKey,
            sandboxRoute: { kind: 'shared', routeKey },
          },
        })
      );
    };

    await runInDurableObject(otherStub, async instance => {
      await registerReadySession(instance, {
        sessionId: otherSessionId,
        userId: otherUserId,
        kiloSessionId: '67676767-6767-4676-8676-676767676767',
        prompt: 'other session',
        mode: 'code',
        model: 'test-model',
        sandboxId: routeKey,
      });
      await installSharedMetadata(instance);
    });

    const result = await runInDurableObject(affectedStub, async instance => {
      const deliveredPlans: FencedWrapperDispatchRequest[] = [];
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          deliveredPlans.push(plan);
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_shared_recovery' };
        },
      };
      let destroyCalls = 0;
      instance['postExhaustionSandboxDestroyer'] = async () => {
        destroyCalls += 1;
      };
      await registerReadySession(instance, {
        sessionId: affectedSessionId,
        userId: affectedUserId,
        kiloSessionId: '78787878-7878-4787-8787-787878787878',
        prompt: 'affected session',
        mode: 'code',
        model: 'test-model',
        sandboxId: routeKey,
      });
      await installSharedMetadata(instance);
      await instance.ctx.storage.put('wrapper_runtime_state', { wrapperGeneration: 6 });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'stop_needed',
        nextInstanceGeneration: 7,
        target: { kind: 'session' },
        reason: 'unhealthy-wrapper',
        requestedAt: 200,
        nextAttemptAt: 3_153_600_000_200,
        attempts: 5,
        lastError: 'wrapper remains present',
        exhaustedAt: 200,
      });
      const admission = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId: affectedUserId,
          prompt: 'queued for shared failover',
          messageId: followUpMessageId,
        })
      );
      expect(admission.success).toBe(true);

      await instance.alarm();

      return {
        deliveredPlans,
        destroyCalls,
        metadata: await instance.getMetadata(),
        pendingMessages: await listPendingSessionMessages(instance.ctx.storage),
        wrapperLease: await getWrapperLease(instance.ctx.storage),
      };
    });
    const otherMetadata = await runInDurableObject(otherStub, instance => instance.getMetadata());

    expect(result.destroyCalls).toBe(0);
    expect(result.metadata?.workspace).toMatchObject({
      sandboxId: replacementSandboxId,
      sandboxRoute: {
        kind: 'shared',
        routeKey,
        suffix: SHARED_SANDBOX_FAILOVER_SUFFIX,
      },
    });
    expect(result.pendingMessages).toHaveLength(0);
    expect(result.deliveredPlans).toHaveLength(1);
    expect(result.deliveredPlans[0].turn.messageId).toBe(followUpMessageId);
    expect(result.deliveredPlans[0].workspace.sandboxId).toBe(replacementSandboxId);
    expect(result.deliveredPlans[0].wrapper.fence.wrapperGeneration).toBeGreaterThan(6);
    expect(result.wrapperLease).toMatchObject({ state: 'owns_wrapper' });
    expect(otherMetadata?.workspace).toMatchObject({
      sandboxId: routeKey,
      sandboxRoute: { kind: 'shared', routeKey },
    });
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
