import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';
import {
  PENDING_SESSION_MESSAGE_LIMIT,
  clearPendingSessionMessages,
  countPendingSessionMessages,
  deletePendingSessionMessageByMessageId,
  findPendingSessionMessageByClientRequestId,
  listPendingSessionMessages,
  storePendingSessionMessage,
  type PendingSessionMessage,
} from '../../../src/session/pending-messages.js';
import { createEventQueries } from '../../../src/session/queries/events.js';
import {
  getSessionMessageState,
  listMessagesWithPendingCallbacks,
  listNonTerminalAcceptedMessages,
  putSessionMessageState,
} from '../../../src/session/session-message-state.js';
import {
  queueRegisteredInitialInput,
  queueUserMessageInput,
  registerReadySession,
} from '../../helpers/session-setup.js';

const createMessage = (overrides: Partial<PendingSessionMessage>): PendingSessionMessage => ({
  messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
  role: 'user',
  content: 'hello',
  createdAt: 1,
  ...overrides,
});

describe('pending session messages', () => {
  it('lists messages in FIFO key order', async () => {
    const userId = 'user_pending_fifo';
    const sessionId = 'agent_pending_fifo';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const messages = await runInDurableObject(stub, async instance => {
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId: 'msg_018f1e2d3c4bBBBBBBBBBBBBBB', createdAt: 20 })
      );
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA', createdAt: 10 })
      );

      return listPendingSessionMessages(instance.ctx.storage);
    });

    expect(messages.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bAAAAAAAAAAAAAA',
      'msg_018f1e2d3c4bBBBBBBBBBBBBBB',
    ]);
  });

  it('deletes every matching messageId', async () => {
    const userId = 'user_pending_delete';
    const sessionId = 'agent_pending_delete';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId: 'msg_018f1e2d3c4bDelMsgAbCdEfGh', createdAt: 1 })
      );
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId: 'msg_018f1e2d3c4bDelMsgAbCdEfGh', createdAt: 2 })
      );
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId: 'msg_018f1e2d3c4bKeepMsgAbCdEfG', createdAt: 3 })
      );

      const deleted = await deletePendingSessionMessageByMessageId(
        instance.ctx.storage,
        'msg_018f1e2d3c4bDelMsgAbCdEfGh'
      );
      const missing = await deletePendingSessionMessageByMessageId(
        instance.ctx.storage,
        'msg_018f1e2d3c4bMissingMessage'
      );
      const remaining = await listPendingSessionMessages(instance.ctx.storage);
      return { deleted, missing, remaining };
    });

    expect(result.deleted).toBe(true);
    expect(result.missing).toBe(false);
    expect(result.remaining.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bKeepMsgAbCdEfG',
    ]);
  });

  it('finds by clientRequestId', async () => {
    const userId = 'user_pending_client_request';
    const sessionId = 'agent_pending_client_request';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const found = await runInDurableObject(stub, async instance => {
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bCliReqAbCdEfGh',
          executionId: 'exc_compatibility',
          clientRequestId: 'client-request-1',
        })
      );

      return findPendingSessionMessageByClientRequestId(instance.ctx.storage, 'client-request-1');
    });

    expect(found?.messageId).toBe('msg_018f1e2d3c4bCliReqAbCdEfGh');
    expect(found?.executionId).toBe('exc_compatibility');
  });

  it('ignores invalid stored entries', async () => {
    const userId = 'user_pending_invalid';
    const sessionId = 'agent_pending_invalid';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const messages = await runInDurableObject(stub, async instance => {
      await instance.ctx.storage.put('pending_message:0000000000000001:invalid', {
        messageId: 'msg_018F1e2d3c4bAbCdEfGhIjKlMn',
        role: 'user',
        content: 'bad',
        createdAt: 1,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId: 'msg_018f1e2d3c4bValidMsgAbCdEf', createdAt: 2 })
      );

      return listPendingSessionMessages(instance.ctx.storage);
    });

    expect(messages.map(message => message.messageId)).toEqual(['msg_018f1e2d3c4bValidMsgAbCdEf']);
  });

  it('clears valid messages and ignores invalid stored entries', async () => {
    const userId = 'user_pending_clear';
    const sessionId = 'agent_pending_clear';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await instance.ctx.storage.put('pending_message:0000000000000001:invalid', {
        messageId: 'invalid',
        role: 'user',
        content: 'bad',
        createdAt: 1,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId: 'msg_018f1e2d3c4bClearAMsgAbCdE', createdAt: 2 })
      );
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId: 'msg_018f1e2d3c4bClearBMsgAbCdE', createdAt: 3 })
      );

      const cleared = await clearPendingSessionMessages(instance.ctx.storage);
      const remaining = await listPendingSessionMessages(instance.ctx.storage);
      const rawInvalid = await instance.ctx.storage.get('pending_message:0000000000000001:invalid');
      return { cleared, remaining, rawInvalid };
    });

    expect(result.cleared.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bClearAMsgAbCdE',
      'msg_018f1e2d3c4bClearBMsgAbCdE',
    ]);
    expect(result.remaining).toHaveLength(0);
    expect(result.rawInvalid).toBeDefined();
  });

  it('counts messages up to the queue limit', async () => {
    const userId = 'user_pending_count';
    const sessionId = 'agent_pending_count';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const count = await runInDurableObject(stub, async instance => {
      for (let index = 0; index < PENDING_SESSION_MESSAGE_LIMIT; index++) {
        await storePendingSessionMessage(
          instance.ctx.storage,
          createMessage({
            messageId: `msg_018f1e2d3c4b${String(index).padStart(14, 'A')}`,
            createdAt: index,
          })
        );
      }

      return countPendingSessionMessages(instance.ctx.storage);
    });

    expect(count).toBe(PENDING_SESSION_MESSAGE_LIMIT);
  });

  it('refreshes stale past alarms when queue admission schedules pending work', async () => {
    const userId = 'user_pending_stale_alarm';
    const sessionId = 'agent_pending_stale_alarm';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-stale-alarm',
      });
      const now = Date.now();
      await instance.ctx.storage.setAlarm(now - 120_000);
      const staleAlarm = await instance.ctx.storage.getAlarm();
      const queueResult = await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'refresh stale pending drain alarm',
        })
      );
      const refreshedAlarm = await instance.ctx.storage.getAlarm();

      return { now, staleAlarm, queueResult, refreshedAlarm };
    });

    expect(result.queueResult).toMatchObject({ success: true, delivery: 'queued' });
    expect(result.staleAlarm).toBeDefined();
    expect(result.refreshedAlarm).toBeGreaterThan(result.staleAlarm ?? result.now);
  });

  it('flushes one FIFO message on alarm and deletes after orchestrator accepts', async () => {
    const userId = 'user_pending_flush';
    const sessionId = 'agent_pending_flush';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      let acceptedMessageId: string | undefined;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          acceptedMessageId = plan.turn.messageId;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '55555555-5555-4555-5555-555555555555',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bFlushMsgAbCdEf',
          executionId: 'exc_flush',
          content: 'flush me',
          createdAt: 1,
        })
      );

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const acceptedMessages = await listNonTerminalAcceptedMessages(instance.ctx.storage);
      return { acceptedMessageId, pending, acceptedMessages };
    });

    expect(result.acceptedMessageId).toBe('msg_018f1e2d3c4bFlushMsgAbCdEf');
    expect(result.pending).toHaveLength(0);
    expect(result.acceptedMessages).toHaveLength(1);
    expect(result.acceptedMessages[0]?.messageId).toBe('msg_018f1e2d3c4bFlushMsgAbCdEf');
  });

  it('rebuilds queued image descriptors into the flush delivery plan', async () => {
    const userId = 'user_pending_flush_images';
    const sessionId = 'agent_pending_flush_images';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const images = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.png'],
    };

    const result = await runInDurableObject(stub, async instance => {
      let deliveredImages: unknown;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          deliveredImages = plan.turn.images;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '58585858-5858-4585-8585-585858585858',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup-images',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bImgFlushAbCdEf',
          content: 'flush image prompt',
          createdAt: 1,
          images,
        })
      );

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { deliveredImages, pending };
    });

    expect(result.deliveredImages).toEqual(images);
    expect(result.pending).toHaveLength(0);
  });

  it('keeps queued messages when flush returns an unsuccessful result without throwing', async () => {
    const userId = 'user_pending_flush_unsuccessful';
    const sessionId = 'agent_pending_flush_unsuccessful';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      instance['executeDirectly'] = async () => ({
        success: false,
        code: 'WORKSPACE_SETUP_FAILED',
        error: 'execution add failed',
      });

      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '56565656-5656-4565-8565-565656565656',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bFlushResAbCdEf',
          executionId: 'exc_flush_result_fail',
          content: 'flush me later',
          createdAt: 1,
        })
      );

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const alarm = await instance.ctx.storage.getAlarm();
      return { pending, alarm };
    });

    expect(result.pending.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bFlushResAbCdEf',
    ]);
    expect(result.pending[0]?.flushAttempts).toBe(1);
    expect(result.pending[0]?.lastFlushError).toBe('execution add failed');
    expect(result.pending[0]?.nextFlushAttemptAt).toBeGreaterThan(Date.now());
    expect(result.alarm).toBe(result.pending[0]?.nextFlushAttemptAt);
  });

  it('records a failed flush attempt and schedules a delayed retry', async () => {
    const userId = 'user_pending_flush_fail';
    const sessionId = 'agent_pending_flush_fail';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      (instance as any).orchestrator = {
        execute: async () => {
          throw new Error('wrapper unavailable');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '44444444-4444-4444-4444-444444444444',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bFlushFalAbCdEf',
          executionId: 'exc_flush_fail',
          content: 'flush me later',
          createdAt: 1,
        })
      );

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const alarm = await instance.ctx.storage.getAlarm();
      return { pending, alarm };
    });

    expect(result.pending.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bFlushFalAbCdEf',
    ]);
    expect(result.pending[0]?.flushAttempts).toBe(1);
    expect(result.pending[0]?.lastFlushError).toBe('wrapper unavailable');
    expect(result.pending[0]?.nextFlushAttemptAt).toBeGreaterThan(Date.now());
    expect(result.alarm).toBe(result.pending[0]?.nextFlushAttemptAt);
  });

  it('schedules wrapper liveness before a delayed pending retry without one-second churn', async () => {
    const userId = 'user_pending_retry_liveness';
    const sessionId = 'agent_pending_retry_liveness';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const now = Date.now();
      const livenessDeadline = now + 5_000;
      const pendingRetryAt = now + 15_000;
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '57575757-5757-4575-8575-575757575757',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await instance.addExecution({
        executionId: 'exc_liveness_before_pending',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_liveness_before_pending',
        messageId: 'msg_018f1e2d3c4bLiveBeforePend',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_liveness_before_pending',
        wrapperExecutionId: 'exc_liveness_before_pending',
        acceptedExecutionId: 'exc_liveness_before_pending',
        nextPingAt: livenessDeadline,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bDelayRetryPend',
          executionId: 'exc_delay_retry_pending',
          content: 'retry later',
          createdAt: 1,
          nextFlushAttemptAt: pendingRetryAt,
        })
      );

      await instance.alarm();
      const alarm = await instance.ctx.storage.getAlarm();
      return { alarm, livenessDeadline, pendingRetryAt, now };
    });

    expect(result.alarm).toBeGreaterThanOrEqual(result.livenessDeadline);
    expect(result.alarm).toBeLessThan(result.pendingRetryAt);
    expect(result.alarm).toBeGreaterThan(result.now + 1_000);
  });

  it('exhausts failed flush retries, emits cloud.message.failed, and removes the pending message', async () => {
    const userId = 'user_pending_flush_exhaust';
    const sessionId = 'agent_pending_flush_exhaust';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      (instance as any).orchestrator = {
        execute: async () => {
          throw new Error('wrapper still unavailable');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '45454545-4545-4545-8545-454545454545',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA',
          content: 'flush until exhausted',
          createdAt: 1,
          flushAttempts: 4,
          nextFlushAttemptAt: Date.now() - 1,
        })
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA',
        status: 'queued',
        prompt: 'flush until exhausted',
        createdAt: 1,
        queuedAt: 1,
      });

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ eventTypes: ['cloud.message.failed'] });
      return {
        pending,
        events: events.map(event => ({ ...event, payload: JSON.parse(event.payload) })),
      };
    });

    expect(result.pending).toHaveLength(0);
    const failedEvent = result.events.find(
      event =>
        event.stream_event_type === 'cloud.message.failed' && event.payload.delivery === 'queued'
    );
    expect(failedEvent).toBeDefined();
    const payload = failedEvent?.payload ?? {};
    expect(payload).toMatchObject({
      messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA',
      error: 'wrapper still unavailable',
      delivery: 'queued',
      accepted: false,
      completionSource: 'delivery_failure',
    });
  });

  it('interrupt clears pending messages and emits cloud.message.failed for each queued message', async () => {
    const userId = 'user_pending_interrupt_clear';
    const sessionId = 'agent_pending_interrupt_clear';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '66666666-6666-4666-8666-666666666666',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bIntrAMsgAbCdEf',
          content: 'first queued',
          createdAt: 1,
        })
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bIntrAMsgAbCdEf',
        status: 'queued',
        prompt: 'first queued',
        createdAt: 1,
        queuedAt: 1,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bIntrBMsgAbCdEf',
          content: 'second queued',
          createdAt: 2,
        })
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bIntrBMsgAbCdEf',
        status: 'queued',
        prompt: 'second queued',
        createdAt: 2,
        queuedAt: 2,
      });

      const interrupt = await instance.interruptExecution();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({
        eventTypes: ['cloud.message.failed'],
      });
      return { interrupt, pending, events };
    });

    expect(result.interrupt.success).toBe(true);
    expect(result.pending).toHaveLength(0);
    const failedPayloads = result.events
      .filter(event => event.stream_event_type === 'cloud.message.failed')
      .map(event => JSON.parse(event.payload));
    expect(failedPayloads).toEqual([
      {
        messageId: 'msg_018f1e2d3c4bIntrAMsgAbCdEf',
        status: 'interrupted',
        delivery: 'queued',
        accepted: false,
        completionSource: 'interrupt',
        reason: 'interrupted',
        error: 'Pending queued message interrupted by user',
      },
      {
        messageId: 'msg_018f1e2d3c4bIntrBMsgAbCdEf',
        status: 'interrupted',
        delivery: 'queued',
        accepted: false,
        completionSource: 'interrupt',
        reason: 'interrupted',
        error: 'Pending queued message interrupted by user',
      },
    ]);
  });

  it('interrupt with pending-only and no current runtime execution returns success', async () => {
    const userId = 'user_pending_interrupt_only';
    const sessionId = 'agent_pending_interrupt_only';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '77777777-7777-4777-8777-777777777777',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bPendOnlyAbCdEf',
          executionId: 'exc_pending_only',
          content: 'queued only',
          createdAt: 1,
        })
      );

      const interrupt = await instance.interruptExecution();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const currentRuntimeExecution = await instance.getCurrentRuntimeExecution();
      return { interrupt, pending, currentRuntimeExecution };
    });

    expect(result.interrupt).toEqual({ success: true, executionId: undefined });
    expect(result.pending).toHaveLength(0);
    expect(result.currentRuntimeExecution).toBeNull();
  });

  it('interrupt with current wrapper runtime execution sends kill and clears queued messages', async () => {
    const userId = 'user_pending_interrupt_active';
    const sessionId = 'agent_pending_interrupt_active';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const sentCommands: unknown[] = [];
      instance.sendToWrapper = (_ingestTagId, command) => {
        sentCommands.push(command);
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '88888888-8888-4888-8888-888888888888',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
      });
      await instance.addExecution({
        executionId: 'exc_interrupt_active',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_interrupt_active',
        messageId: 'msg_018f1e2d3c4bAcceptActAbCdE',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_active',
        wrapperExecutionId: 'exc_interrupt_active',
        acceptedMessageId: 'msg_018f1e2d3c4bAcceptActAbCdE',
        acceptedExecutionId: 'exc_interrupt_active',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bActQueueAbCdEf',
          executionId: 'exc_interrupt_queued',
          content: 'queued behind active',
          createdAt: 1,
        })
      );

      const interrupt = await instance.interruptExecution();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const currentRuntimeExecution = await instance.getCurrentRuntimeExecution();
      return { interrupt, pending, currentRuntimeExecution, sentCommands };
    });

    expect(result.interrupt.success).toBe(true);
    expect(result.interrupt.executionId).toBe('exc_interrupt_active');
    expect(result.sentCommands).toEqual([{ type: 'kill', signal: 'SIGTERM' }]);
    expect(result.pending).toHaveLength(0);
    expect(result.currentRuntimeExecution?.messageId).toBe('msg_018f1e2d3c4bAcceptActAbCdE');
  });

  it('defers pending messages on debounce cadence while current runtime execution exists', async () => {
    const userId = 'user_pending_flush_active';
    const sessionId = 'agent_pending_flush_active';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      let callCount = 0;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          callCount += 1;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '33333333-3333-4333-3333-333333333333',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await instance.addExecution({
        executionId: 'exc_active_flush',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_active_flush',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_active_flush',
        wrapperRunId: 'wr_active_flush',
        wrapperExecutionId: 'exc_active_flush',
        acceptedExecutionId: 'exc_active_flush',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bActBusyRunAbCd',
        status: 'accepted',
        prompt: 'active work',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: 'wr_active_flush',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bActFlushOneAbC',
          executionId: 'exc_active_pending_one',
          content: 'first',
          createdAt: 1,
        })
      );
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bActFlushTwoAbC',
          executionId: 'exc_active_pending_two',
          content: 'second',
          createdAt: 2,
        })
      );

      const beforeAlarm = Date.now();
      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const alarm = await instance.ctx.storage.getAlarm();
      return { callCount, pending, alarm, beforeAlarm };
    });

    expect(result.callCount).toBe(0);
    expect(result.pending.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bActFlushOneAbC',
      'msg_018f1e2d3c4bActFlushTwoAbC',
    ]);
    expect(result.alarm).toBeGreaterThanOrEqual(result.beforeAlarm + 1_000);
    expect(result.alarm).toBeLessThan(result.beforeAlarm + 10_000);
  });

  it('metadata-not-ready flush keeps pending and schedules retry', async () => {
    const userId = 'user_pending_not_ready';
    const sessionId = 'agent_pending_not_ready';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await instance.updateMetadata({
        version: Date.now(),
        sessionId,
        userId,
        timestamp: Date.now(),
        mode: 'code',
        model: 'test-model',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bNotReadyAbCdEf',
          executionId: 'exc_not_ready_flush',
          content: 'wait for initiation',
          createdAt: 1,
        })
      );

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const alarm = await instance.ctx.storage.getAlarm();
      return { pending, alarm };
    });

    expect(result.pending.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bNotReadyAbCdEf',
    ]);
    expect(result.alarm).toBeGreaterThan(Date.now());
  });

  it('accepted execution completion emits cloud.message.completed with messageId and executionId', async () => {
    const userId = 'user_accepted_completed';
    const sessionId = 'agent_accepted_completed';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-completed',
      });
      await instance.addExecution({
        executionId: 'exc_accepted_completed',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_accepted_completed',
        messageId: 'msg_018f1e2d3c4bAcceptDoneAbCd',
      });

      await instance.updateExecutionStatus({
        executionId: 'exc_accepted_completed',
        status: 'running',
      });
      await instance.updateExecutionStatus({
        executionId: 'exc_accepted_completed',
        status: 'completed',
        gateResult: 'pass',
      });
      const duplicateResult = await instance.updateExecutionStatus({
        executionId: 'exc_accepted_completed',
        status: 'completed',
      });

      const eventQueries = createEventQueries(
        drizzle(instance.ctx.storage, { logger: false }),
        instance.ctx.storage.sql
      );
      const events = eventQueries.findByFilters({ eventTypes: ['cloud.message.completed'] });
      return { events, duplicateResult };
    });

    expect(result.duplicateResult.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(JSON.parse(result.events[0].payload)).toEqual({
      messageId: 'msg_018f1e2d3c4bAcceptDoneAbCd',
      executionId: 'exc_accepted_completed',
      status: 'completed',
      gateResult: 'pass',
      delivery: 'sent',
      accepted: true,
    });
  });

  it('legacy reconnect complete terminalizes its accepted execution message', async () => {
    const userId = 'user_legacy_reconnect_complete';
    const sessionId = 'agent_legacy_reconnect_complete';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-legacy-reconnect-complete',
      });
      await instance.addExecution({
        executionId: 'exc_legacy_reconnect_complete',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_legacy_reconnect_complete',
        messageId: 'msg_018f1e2d3c4bLegacyDoneAbC',
      });
      await instance.updateExecutionStatus({
        executionId: 'exc_legacy_reconnect_complete',
        status: 'running',
      });

      const handler = await instance['getIngestHandler']();
      const ws = {
        deserializeAttachment: () => ({
          executionId: 'exc_legacy_reconnect_complete',
          connectedAt: Date.now(),
          kiloSessionState: { captured: false },
          lastHeartbeatUpdate: Date.now(),
          lastEventAtUpdate: Date.now(),
        }),
        serializeAttachment: () => {},
        send: () => {},
      } as unknown as WebSocket;

      await handler.handleIngestMessage(
        ws,
        JSON.stringify({
          streamEventType: 'complete',
          data: { exitCode: 0 },
          timestamp: new Date().toISOString(),
        })
      );

      const execution = await instance.getExecution('exc_legacy_reconnect_complete');
      const eventQueries = createEventQueries(
        drizzle(instance.ctx.storage, { logger: false }),
        instance.ctx.storage.sql
      );
      const events = eventQueries.findByFilters({ eventTypes: ['cloud.message.completed'] });
      return { execution, events };
    });

    expect(result.execution?.status).toBe('completed');
    expect(result.events).toHaveLength(1);
    expect(JSON.parse(result.events[0].payload)).toMatchObject({
      messageId: 'msg_018f1e2d3c4bLegacyDoneAbC',
      executionId: 'exc_legacy_reconnect_complete',
      status: 'completed',
    });
  });

  it('suppressed accepted execution completion skips terminal event and callback enqueue', async () => {
    const userId = 'user_accepted_suppressed';
    const sessionId = 'agent_accepted_suppressed';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const sentCallbackJobs: unknown[] = [];
      (
        instance.env as typeof instance.env & {
          CALLBACK_QUEUE: { send: (job: unknown) => Promise<void> };
        }
      ).CALLBACK_QUEUE = {
        send: async job => {
          sentCallbackJobs.push(job);
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kiloSessionId: '33333333-3333-4333-3333-333333333333',
        kilocodeToken: 'token-suppressed',
        callbackTarget: { url: 'https://example.com/callback' },
      });
      await instance.addExecution({
        executionId: 'exc_accepted_suppressed',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_accepted_suppressed',
        messageId: 'msg_018f1e2d3c4bAcceptMuteAbCd',
      });

      await instance.updateExecutionStatus(
        {
          executionId: 'exc_accepted_suppressed',
          status: 'completed',
        },
        { suppressCallback: true }
      );

      const eventQueries = createEventQueries(
        drizzle(instance.ctx.storage, { logger: false }),
        instance.ctx.storage.sql
      );
      const events = eventQueries.findByFilters({ eventTypes: ['cloud.message.completed'] });
      return { events, sentCallbackJobs };
    });

    expect(result.events).toHaveLength(0);
    expect(result.sentCallbackJobs).toHaveLength(0);
  });

  it('accepted execution completion callback includes messageId when present', async () => {
    const userId = 'user_accepted_callback_message';
    const sessionId = 'agent_accepted_callback_message';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const sentCallbackJobs: Array<{
        payload: { executionId: string; messageId?: string; status: 'completed' };
      }> = [];

      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kiloSessionId: '44444444-4444-4444-8444-444444444444',
        kilocodeToken: 'token-callback-message',
        callbackTarget: { url: 'https://example.com/callback' },
      });
      await instance.addExecution({
        executionId: 'exc_accepted_callback_message',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_accepted_callback_message',
        messageId: 'msg_018f1e2d3c4bCallMsgAbCdEfG',
      });

      const enqueueCallbackNotification = instance['enqueueCallbackNotification'].bind(
        instance
      ) as (
        execution: { executionId: string; messageId?: string },
        status: 'completed'
      ) => Promise<void>;
      instance['enqueueCallbackNotification'] = async (execution, status) => {
        const payload: { executionId: string; messageId?: string; status: 'completed' } = {
          executionId: execution.executionId,
          status,
        };
        if (execution.messageId) {
          payload.messageId = execution.messageId;
        }
        sentCallbackJobs.push({ payload });
        await enqueueCallbackNotification(execution, status);
      };

      await instance.updateExecutionStatus({
        executionId: 'exc_accepted_callback_message',
        status: 'running',
      });
      await instance.updateExecutionStatus({
        executionId: 'exc_accepted_callback_message',
        status: 'completed',
      });

      return sentCallbackJobs;
    });

    expect(result).toHaveLength(1);
    expect(result[0].payload).toMatchObject({
      executionId: 'exc_accepted_callback_message',
      messageId: 'msg_018f1e2d3c4bCallMsgAbCdEfG',
    });
  });

  it('prepared initial execution completion uses the prepared initialMessageId', async () => {
    const userId = 'user_prepared_initial_completed';
    const sessionId = 'agent_prepared_initial_completed';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kiloSessionId: '55555555-5555-4555-8555-555555555555',
        kilocodeToken: 'token-prepared-initial',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
        callbackTarget: { url: 'https://example.com/callback' },
        initialMessageId: 'msg_018f1e2d3c4bTermInitMsgABC',
      });
      const startResult = await instance.queueSessionMessage(
        queueRegisteredInitialInput({ userId })
      );
      await instance.alarm();

      // Terminalize the message through the centralized message path
      // (new paths are message-based, not execution-based).
      await (instance as any).terminalizeSessionMessageOnce('msg_018f1e2d3c4bTermInitMsgABC', {
        kind: 'completed',
        completionSource: 'assistant_message_event',
        assistantMessageId: 'assistant_msg_term',
      });

      const eventQueries = createEventQueries(
        drizzle(instance.ctx.storage, { logger: false }),
        instance.ctx.storage.sql
      );
      const events = eventQueries.findByFilters({ eventTypes: ['cloud.message.completed'] });
      return { startResult, events };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;
    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bTermInitMsgABC');
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(result.events[0].payload)).toMatchObject({
      messageId: 'msg_018f1e2d3c4bTermInitMsgABC',
      status: 'completed',
    });
  });

  it('accepted execution failure emits cloud.message.failed with accepted marker', async () => {
    const userId = 'user_accepted_failed';
    const sessionId = 'agent_accepted_failed';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-failed',
      });
      await instance.addExecution({
        executionId: 'exc_accepted_failed',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_accepted_failed',
        messageId: 'msg_018f1e2d3c4bAcceptFailAbCd',
      });

      const failed = await instance.failExecutionRpc({
        executionId: 'exc_accepted_failed',
        error: 'fatal failure',
        status: 'failed',
      });

      const eventQueries = createEventQueries(
        drizzle(instance.ctx.storage, { logger: false }),
        instance.ctx.storage.sql
      );
      const events = eventQueries.findByFilters({ eventTypes: ['cloud.message.failed'] });
      return { failed, events };
    });

    expect(result.failed).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(JSON.parse(result.events[0].payload)).toEqual({
      messageId: 'msg_018f1e2d3c4bAcceptFailAbCd',
      executionId: 'exc_accepted_failed',
      status: 'failed',
      reason: 'execution',
      error: 'fatal failure',
      delivery: 'sent',
      accepted: true,
    });
  });

  it('completion schedules and advances the next pending message', async () => {
    const userId = 'user_pending_completion';
    const sessionId = 'agent_pending_completion';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const acceptedMessageIds: string[] = [];
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          acceptedMessageIds.push(plan.turn.messageId);
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '22222222-2222-4222-2222-222222222222',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await instance.addExecution({
        executionId: 'exc_completion_active',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_completion_active',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_completion_active',
        wrapperExecutionId: 'exc_completion_active',
        acceptedExecutionId: 'exc_completion_active',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bComplNextAbCdE',
          executionId: 'exc_completion_next',
          content: 'next message',
          createdAt: 1,
        })
      );

      await instance.onExecutionComplete('exc_completion_active', 'completed');
      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const acceptedMessages = await listNonTerminalAcceptedMessages(instance.ctx.storage);
      return { acceptedMessageIds, pending, acceptedMessages };
    });

    expect(result.acceptedMessageIds).toEqual(['msg_018f1e2d3c4bComplNextAbCdE']);
    expect(result.pending).toHaveLength(0);
    expect(result.acceptedMessages).toHaveLength(1);
    expect(result.acceptedMessages[0]?.messageId).toBe('msg_018f1e2d3c4bComplNextAbCdE');
  });

  it('terminalizes session message state when delivery retries exhaust', async () => {
    const userId = 'user_pending_exhaust_terminal';
    const sessionId = 'agent_pending_exhaust_terminal';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      (instance as any).orchestrator = {
        execute: async () => {
          throw new Error('wrapper still unavailable');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-exhaust-terminal',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bExhstTrmAAAAA1',
        status: 'queued',
        prompt: 'flush until exhausted',
        createdAt: Date.now(),
        queuedAt: Date.now(),
        callbackRequired: true,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bExhstTrmAAAAA1',
          content: 'flush until exhausted',
          createdAt: 1,
          flushAttempts: 4,
          nextFlushAttemptAt: Date.now() - 1,
        })
      );

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const messageState = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bExhstTrmAAAAA1'
      );
      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const events = eventQueries.findByFilters({ eventTypes: ['cloud.message.failed'] });
      return {
        pending,
        messageState,
        events: events.map(event => ({ ...event, payload: JSON.parse(event.payload) })),
      };
    });

    expect(result.pending).toHaveLength(0);
    expect(result.messageState).toMatchObject({
      messageId: 'msg_018f1e2d3c4bExhstTrmAAAAA1',
      status: 'failed',
      failureReason: 'exhausted',
      completionSource: 'delivery_failure',
      attempts: 5,
    });
    const failedEvent = result.events.find(
      event => event.stream_event_type === 'cloud.message.failed'
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload).toMatchObject({
      messageId: 'msg_018f1e2d3c4bExhstTrmAAAAA1',
      reason: 'exhausted',
      attempts: 5,
      completionSource: 'delivery_failure',
    });
  });

  it('terminalizes session message state when queued message is interrupted', async () => {
    const userId = 'user_pending_interrupt_terminal';
    const sessionId = 'agent_pending_interrupt_terminal';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-interrupt-terminal',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bIntrTrmAAAAA12',
        status: 'queued',
        prompt: 'first queued',
        createdAt: Date.now(),
        queuedAt: Date.now(),
        callbackRequired: true,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bIntrTrmAAAAA12',
          content: 'first queued',
          createdAt: 1,
        })
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bIntrTrmBBBBB12',
        status: 'queued',
        prompt: 'second queued',
        createdAt: Date.now(),
        queuedAt: Date.now(),
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bIntrTrmBBBBB12',
          content: 'second queued',
          createdAt: 2,
        })
      );

      await instance.interruptExecution();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const stateA = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bIntrTrmAAAAA12'
      );
      const stateB = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bIntrTrmBBBBB12'
      );
      return { pending, stateA, stateB };
    });

    expect(result.pending).toHaveLength(0);
    expect(result.stateA).toMatchObject({
      messageId: 'msg_018f1e2d3c4bIntrTrmAAAAA12',
      status: 'interrupted',
      completionSource: 'interrupt',
    });
    expect(result.stateB).toMatchObject({
      messageId: 'msg_018f1e2d3c4bIntrTrmBBBBB12',
      status: 'interrupted',
      completionSource: 'interrupt',
    });
  });

  it('re-queues a failed message id as a fresh attempt instead of returning stale queued ack', async () => {
    const userId = 'user_pending_retry_terminal';
    const sessionId = 'agent_pending_retry_terminal';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      (instance as any).orchestrator = {
        execute: async () => {
          throw new Error('wrapper still unavailable');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-retry-terminal',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bRtryTrmAAAAA12',
        status: 'queued',
        prompt: 'flush until exhausted',
        createdAt: Date.now(),
        queuedAt: Date.now(),
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bRtryTrmAAAAA12',
          content: 'flush until exhausted',
          createdAt: 1,
          flushAttempts: 4,
          nextFlushAttemptAt: Date.now() - 1,
        })
      );

      await instance.alarm();

      const messageState = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bRtryTrmAAAAA12'
      );

      const retryResult = await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'retry same message',
          messageId: 'msg_018f1e2d3c4bRtryTrmAAAAA12',
        })
      );

      const retriedState = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bRtryTrmAAAAA12'
      );

      return { messageState, retryResult, retriedState };
    });

    expect(result.messageState?.status).toBe('failed');
    expect(result.retryResult.success).toBe(true);
    expect(result.retriedState?.status).toBe('queued');
  });

  it('callback-required failed delivery is visible to listMessagesWithPendingCallbacks', async () => {
    const userId = 'user_pending_callback_visible';
    const sessionId = 'agent_pending_callback_visible';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      (instance as any).orchestrator = {
        execute: async () => {
          throw new Error('wrapper still unavailable');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'd4d4d4d4-d4d4-4d4c-8d4c-d4d4d4d4d4d4',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-callback-visible',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bCbVsblAAAAAAAA',
        status: 'queued',
        prompt: 'flush until exhausted',
        createdAt: Date.now(),
        queuedAt: Date.now(),
        callbackRequired: true,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bCbVsblAAAAAAAA',
          content: 'flush until exhausted',
          createdAt: 1,
          flushAttempts: 4,
          nextFlushAttemptAt: Date.now() - 1,
        })
      );

      await instance.alarm();
      const pendingCallbacks = await listMessagesWithPendingCallbacks(instance.ctx.storage);
      const messageState = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bCbVsblAAAAAAAA'
      );
      return { pendingCallbacks, messageState };
    });

    expect(result.messageState?.status).toBe('failed');
    expect(result.messageState?.callbackRequired).toBe(true);
    expect(result.pendingCallbacks).toHaveLength(1);
    expect(result.pendingCallbacks[0]?.messageId).toBe('msg_018f1e2d3c4bCbVsblAAAAAAAA');
  });
});
