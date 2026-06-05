import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';
import {
  PENDING_SESSION_MESSAGE_LIMIT,
  clearPendingSessionMessages,
  countPendingSessionMessages,
  deletePendingSessionMessageByMessageId,
  findPendingSessionMessageByClientRequestId,
  createPendingSessionMessageFromIntent,
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
import { getWrapperLease } from '../../../src/session/wrapper-runtime-state.js';

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
    expect(found?.legacyExecutionId).toBe('exc_compatibility');
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
      const queueResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'refresh stale pending drain alarm',
        })
      );
      const refreshedAlarm = await instance.ctx.storage.getAlarm();

      return { now, staleAlarm, queueResult, refreshedAlarm };
    });

    expect(result.queueResult).toMatchObject({ success: true, outcome: 'queued' });
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

  it('flushes canonical document attachment descriptors through the durable queue plan', async () => {
    const userId = 'user_pending_flush_attachments';
    const sessionId = 'agent_pending_flush_attachments';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };

    const result = await runInDurableObject(stub, async instance => {
      let deliveredAttachments: unknown;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          deliveredAttachments = plan.turn.attachments;
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
        kilocodeToken: 'token-followup-attachments',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createPendingSessionMessageFromIntent(
          {
            turn: {
              type: 'prompt',
              messageId: 'msg_018f1e2d3c4bDocFlushAbCdEf',
              prompt: 'flush document prompt',
              attachments,
            },
            agent: { mode: 'code', model: 'test-model' },
          },
          1
        )
      );

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { deliveredAttachments, pending };
    });

    expect(result.deliveredAttachments).toEqual(attachments);
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
    expect(result.alarm).toBeLessThanOrEqual(result.pending[0]?.nextFlushAttemptAt ?? 0);
    expect(result.alarm).toBeGreaterThan(Date.now());
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
    expect(result.alarm).toBeLessThanOrEqual(result.pending[0]?.nextFlushAttemptAt ?? 0);
    expect(result.alarm).toBeGreaterThan(Date.now());
  });

  it('does not consume a delivery attempt while physical wrapper cleanup is still in progress', async () => {
    const userId = 'user_pending_cleanup_gate';
    const sessionId = 'agent_pending_cleanup_gate';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      let deliveryAttempts = 0;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          deliveryAttempts += 1;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '46464646-4646-4646-8646-464646464646',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-cleanup-gate',
      });
      const cleanupDeadline = Date.now() + 60_000;
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'stopping',
        nextInstanceGeneration: 2,
        target: { kind: 'session' },
        reason: 'unexpected-wrapper',
        requestedAt: Date.now() - 1_000,
        attemptId: 'attempt_cleanup_gate',
        attemptStartedAt: Date.now() - 500,
        attemptDeadlineAt: cleanupDeadline,
        attempts: 1,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bCleanGateAbCdE',
          content: 'deliver after cleanup',
          createdAt: 1,
        })
      );

      await instance.alarm();
      const blockedPending = await listPendingSessionMessages(instance.ctx.storage);
      const blockedLease = await getWrapperLease(instance.ctx.storage);
      const blockedAlarm = await instance.ctx.storage.getAlarm();

      await instance.ctx.storage.put('wrapper_lease', {
        state: 'stop_needed',
        nextInstanceGeneration: 2,
        target: { kind: 'session' },
        reason: 'unexpected-wrapper',
        requestedAt: Date.now() - 1_000,
        nextAttemptAt: Date.now(),
        attempts: 1,
      });
      await instance.alarm();
      return {
        deliveryAttempts,
        cleanupDeadline,
        blockedPending,
        blockedLease,
        blockedAlarm,
        finalPending: await listPendingSessionMessages(instance.ctx.storage),
        finalLease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result.blockedPending).toHaveLength(1);
    expect(result.blockedPending[0]?.flushAttempts).toBeUndefined();
    expect(result.blockedPending[0]?.lastFlushError).toBeUndefined();
    expect(result.blockedPending[0]?.deliveryDisposition).toBeUndefined();
    expect(result.blockedLease.state).toBe('stopping');
    expect(result.blockedAlarm).toBe(result.cleanupDeadline);
    expect(result.deliveryAttempts).toBe(1);
    expect(result.finalPending).toHaveLength(0);
    expect(result.finalLease.state).toBe('owns_wrapper');
  });

  it('does not consume a delivery attempt when wrapper authorization discovers required cleanup', async () => {
    const userId = 'user_pending_cleanup_discovery';
    const sessionId = 'agent_pending_cleanup_discovery';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      let deliveryAttempts = 0;
      let authorizationInspections = 0;
      (instance as any).orchestrator = {
        execute: async () => {
          deliveryAttempts += 1;
          throw new Error('delivery must wait for cleanup');
        },
      };
      instance['physicalWrapperObserver'] = async () => {
        authorizationInspections += 1;
        return { status: 'inspection-failed', error: 'provider unavailable' };
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '47474747-4747-4747-8747-474747474747',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-cleanup-discovery',
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bCleanDiscAbCdE',
          content: 'deliver after cleanup discovery',
          createdAt: 1,
        })
      );

      await instance.alarm();
      return {
        authorizationInspections,
        deliveryAttempts,
        pending: await listPendingSessionMessages(instance.ctx.storage),
        lease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result.authorizationInspections).toBe(1);
    expect(result.deliveryAttempts).toBe(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.flushAttempts).toBeUndefined();
    expect(result.pending[0]?.lastFlushError).toBeUndefined();
    expect(result.pending[0]?.deliveryDisposition).toBeUndefined();
    expect(result.lease).toMatchObject({
      state: 'stop_needed',
      target: { kind: 'session' },
      reason: 'observation-failed',
      attempts: 0,
    });
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
          flushAttempts: 1,
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

  it('interrupt with pending-only ignores stranded legacy execution identity', async () => {
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
      await instance.addExecution({
        executionId: 'exc_stranded_interrupt',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_stranded_interrupt',
      });
      await instance.updateExecutionStatus({
        executionId: 'exc_stranded_interrupt',
        status: 'running',
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
      const strandedLegacyExecution = await instance.getCurrentRuntimeExecution();
      return { interrupt, pending, strandedLegacyExecution };
    });

    expect(result.interrupt).toEqual({ success: true, executionId: undefined });
    expect(result.pending).toHaveLength(0);
    expect(result.strandedLegacyExecution?.executionId).toBe('exc_stranded_interrupt');
  });

  it('retains queued pending anchors when the interrupted state write fails', async () => {
    const userId = 'user_pending_interrupt_transition_failure';
    const sessionId = 'agent_pending_interrupt_transition_failure';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '96969696-9696-4969-8969-969696969696',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-interrupt-transition-failure',
      });
      const messageId = 'msg_018f1e2d3c4bIntrPutFailABC';
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({ messageId, content: 'still recoverable', createdAt: 1 })
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId,
        status: 'queued',
        prompt: 'still recoverable',
        createdAt: 1,
        queuedAt: 1,
      });
      const originalPut = instance.ctx.storage.put.bind(instance.ctx.storage);
      let failStateTransition = true;
      instance.ctx.storage.put = async (key, value) => {
        if (
          failStateTransition &&
          key === `session_message:${messageId}` &&
          typeof value === 'object' &&
          value !== null &&
          'status' in value &&
          value.status === 'interrupted'
        ) {
          failStateTransition = false;
          throw new Error('interrupted state put failed');
        }
        return originalPut(key, value);
      };

      await expect(instance.interruptExecution()).rejects.toThrow('interrupted state put failed');
      instance.ctx.storage.put = originalPut;
      return {
        pending: await listPendingSessionMessages(instance.ctx.storage),
        message: await getSessionMessageState(instance.ctx.storage, messageId),
      };
    });

    expect(result.pending.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bIntrPutFailABC',
    ]);
    expect(result.message?.status).toBe('queued');
  });

  it('retains accepted wrapper ownership when its interrupted state write fails', async () => {
    const userId = 'user_accepted_interrupt_transition_failure';
    const sessionId = 'agent_accepted_interrupt_transition_failure';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '97979797-9797-4979-8979-979797979797',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-accepted-transition-failure',
      });
      const messageId = 'msg_018f1e2d3c4bAcptPutFailABC';
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_transition_failure',
        wrapperRunId: 'wr_interrupt_transition_failure',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId,
        status: 'accepted',
        prompt: 'owned by wrapper',
        createdAt: 1,
        acceptedAt: 2,
        wrapperRunId: 'wr_interrupt_transition_failure',
      });
      const originalPut = instance.ctx.storage.put.bind(instance.ctx.storage);
      let failStateTransition = true;
      instance.ctx.storage.put = async (key, value) => {
        if (
          failStateTransition &&
          key === `session_message:${messageId}` &&
          typeof value === 'object' &&
          value !== null &&
          'status' in value &&
          value.status === 'interrupted'
        ) {
          failStateTransition = false;
          throw new Error('accepted interrupted state put failed');
        }
        return originalPut(key, value);
      };

      await expect(instance.interruptExecution()).rejects.toThrow(
        'accepted interrupted state put failed'
      );
      instance.ctx.storage.put = originalPut;
      return {
        message: await getSessionMessageState(instance.ctx.storage, messageId),
        runtime: await instance.ctx.storage.get('wrapper_runtime_state'),
      };
    });

    expect(result.message?.status).toBe('accepted');
    expect(result.runtime).toMatchObject({
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_interrupt_transition_failure',
      wrapperRunId: 'wr_interrupt_transition_failure',
    });
  });

  it('interrupt remains durable when terminal effects and runtime stop fail once', async () => {
    const userId = 'user_pending_interrupt_failure';
    const sessionId = 'agent_pending_interrupt_failure';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '94949494-9494-4949-8949-949494949494',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-interrupt-failure',
        callbackTarget: { url: 'https://example.com/repair-interrupt' },
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_failure',
        wrapperRunId: 'wr_interrupt_failure',
      });
      const acceptedId = 'msg_018f1e2d3c4bIntrFailAcptAB';
      const pendingId = 'msg_018f1e2d3c4bIntrFailPndABC';
      await putSessionMessageState(instance.ctx.storage, {
        messageId: acceptedId,
        status: 'accepted',
        prompt: 'accepted',
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: 'wr_interrupt_failure',
        callbackRequired: true,
        callbackTarget: { url: 'https://example.com/repair-interrupt' },
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: pendingId,
          content: 'pending',
          createdAt: 2,
        })
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId: pendingId,
        status: 'queued',
        prompt: 'pending',
        createdAt: 2,
        queuedAt: 2,
        callbackRequired: true,
        callbackTarget: { url: 'https://example.com/repair-interrupt' },
      });
      let failTerminalEffect = true;
      const originalEnsure = (instance as any).ensureTerminalMessageEvent.bind(instance);
      (instance as any).ensureTerminalMessageEvent = (params: unknown) => {
        if (failTerminalEffect) {
          failTerminalEffect = false;
          throw new Error('interrupt terminal event failed');
        }
        originalEnsure(params);
      };
      instance['physicalWrapperStopper'] = async () => ({
        status: 'inspection-failed',
        error: 'stop failed',
      });

      const interrupt = await instance.interruptExecution();
      await instance.alarm();
      return {
        interrupt,
        pending: await listPendingSessionMessages(instance.ctx.storage),
        accepted: await getSessionMessageState(instance.ctx.storage, acceptedId),
        queued: await getSessionMessageState(instance.ctx.storage, pendingId),
        runtime: await instance.ctx.storage.get('wrapper_runtime_state'),
      };
    });

    expect(result.interrupt).toEqual({ success: true, executionId: undefined });
    expect(result.pending).toHaveLength(0);
    expect(result.accepted?.status).toBe('interrupted');
    expect(result.queued?.status).toBe('interrupted');
    expect(result.runtime).toEqual({ wrapperGeneration: 2 });
  });

  it('interrupt with accepted work preserves durable physical cleanup when absence cannot be confirmed', async () => {
    const userId = 'user_pending_interrupt_cleanup';
    const sessionId = 'agent_pending_interrupt_cleanup';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '87878787-8787-4878-8878-878787878787',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-interrupt-cleanup',
      });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_interrupt', instanceGeneration: 1 },
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_cleanup',
        wrapperRunId: 'wr_interrupt_cleanup',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bIntrCleanAbCdE',
        status: 'accepted',
        prompt: 'active message',
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: 'wr_interrupt_cleanup',
      });
      instance['physicalWrapperStopper'] = async () => ({
        status: 'still-present',
        observed: [],
      });

      const interrupt = await instance.interruptExecution();
      return { interrupt, lease: await getWrapperLease(instance.ctx.storage) };
    });

    expect(result.interrupt).toEqual({ success: true, executionId: undefined });
    expect(result.lease).toMatchObject({
      state: 'stop_needed',
      reason: 'user-interrupt',
      attempts: 1,
    });
  });

  it('interrupt with accepted work and no live socket fences and requests current wrapper cleanup', async () => {
    const userId = 'user_pending_interrupt_no_socket';
    const sessionId = 'agent_pending_interrupt_no_socket';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const stopped: string[] = [];
      instance['physicalWrapperStopper'] = async request => {
        stopped.push(request.reason);
        return { status: 'absent' };
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '89898989-8989-4898-8989-898989898989',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
      });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_interrupt_missing', instanceGeneration: 1 },
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_missing',
        wrapperRunId: 'wr_interrupt_missing',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bNoSockMsgAbCdE',
        status: 'accepted',
        prompt: 'active message',
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: 'wr_interrupt_missing',
      });

      const interrupt = await instance.interruptExecution();
      const runtimeState = await instance.ctx.storage.get<{ wrapperGeneration: number }>(
        'wrapper_runtime_state'
      );
      return {
        interrupt,
        runtimeState,
        stopped,
        lease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result.interrupt).toEqual({ success: true, executionId: undefined });
    expect(result.runtimeState).toEqual({ wrapperGeneration: 2 });
    expect(result.stopped).toEqual(['user-interrupt']);
    expect(result.lease).toMatchObject({ state: 'none' });
  });

  it('interrupt with a live fenced socket and no accepted work requests cleanup and fences reuse', async () => {
    const userId = 'user_pending_interrupt_idle_wrapper';
    const sessionId = 'agent_pending_interrupt_idle_wrapper';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const sentCommands: unknown[] = [];
      const stopped: string[] = [];
      instance.sendToWrapper = (_ingestTagId, command, _fence) => {
        sentCommands.push(command);
        return true;
      };
      instance['physicalWrapperStopper'] = async request => {
        stopped.push(request.reason);
        return { status: 'absent' };
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '97979797-9797-4979-8979-979797979797',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
      });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_interrupt_idle', instanceGeneration: 1 },
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_idle',
        wrapperRunId: 'wr_interrupt_idle',
      });

      const interrupt = await instance.interruptExecution();
      const runtimeState = await instance.ctx.storage.get<{ wrapperGeneration: number }>(
        'wrapper_runtime_state'
      );
      return {
        interrupt,
        runtimeState,
        sentCommands,
        stopped,
        lease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result.interrupt).toEqual({ success: true, executionId: undefined });
    expect(result.sentCommands).toEqual([{ type: 'kill', signal: 'SIGTERM' }]);
    expect(result.runtimeState).toEqual({ wrapperGeneration: 2 });
    expect(result.stopped).toEqual(['user-interrupt']);
    expect(result.lease).toMatchObject({ state: 'none' });
  });

  it('interrupt fences a live wrapper when immediate kill signaling fails', async () => {
    const userId = 'user_pending_interrupt_signal_failure';
    const sessionId = 'agent_pending_interrupt_signal_failure';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const stopped: string[] = [];
      instance.sendToWrapper = () => {
        throw new Error('socket send failed');
      };
      instance['physicalWrapperStopper'] = async request => {
        stopped.push(request.reason);
        return { status: 'absent' };
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '98989898-9898-4989-8989-989898989898',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
      });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_interrupt_signal_failure', instanceGeneration: 1 },
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_signal_failure',
        wrapperRunId: 'wr_interrupt_signal_failure',
      });

      const interrupt = await instance.interruptExecution();
      const runtimeState = await instance.ctx.storage.get<{ wrapperGeneration: number }>(
        'wrapper_runtime_state'
      );
      return {
        interrupt,
        runtimeState,
        stopped,
        lease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result.interrupt).toEqual({ success: true, executionId: undefined });
    expect(result.runtimeState).toEqual({ wrapperGeneration: 2 });
    expect(result.stopped).toEqual(['user-interrupt']);
    expect(result.lease).toMatchObject({ state: 'none' });
  });

  it('interrupt with a live fenced socket sends kill then fences accepted work', async () => {
    const userId = 'user_pending_interrupt_active';
    const sessionId = 'agent_pending_interrupt_active';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const sentCommands: unknown[] = [];
      instance.sendToWrapper = (_ingestTagId, command, _fence) => {
        sentCommands.push(command);
        return true;
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
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_active',
        wrapperRunId: 'wr_interrupt_active',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bAcceptActAbCdE',
        status: 'accepted',
        prompt: 'active message',
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: 'wr_interrupt_active',
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
      const accepted = await listNonTerminalAcceptedMessages(instance.ctx.storage);
      const runtimeState = await instance.ctx.storage.get<{ wrapperGeneration: number }>(
        'wrapper_runtime_state'
      );
      return { interrupt, pending, accepted, sentCommands, runtimeState };
    });

    expect(result.interrupt).toEqual({ success: true, executionId: undefined });
    expect(result.sentCommands).toEqual([{ type: 'kill', signal: 'SIGTERM' }]);
    expect(result.pending).toHaveLength(0);
    expect(result.accepted).toHaveLength(0);
    expect(result.runtimeState).toEqual({ wrapperGeneration: 2 });
  });

  it('ignores late terminal events from the fenced run after current interrupt', async () => {
    const userId = 'user_pending_interrupt_late';
    const sessionId = 'agent_pending_interrupt_late';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '91919191-9191-4919-8919-919191919191',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_interrupt_late',
        wrapperRunId: 'wr_interrupt_late',
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bLateMsgAbCdEfG',
        status: 'accepted',
        prompt: 'interrupted work',
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: 'wr_interrupt_late',
      });

      await instance.interruptExecution();
      await instance.handleWrapperTerminalEvent({
        wrapperRunId: 'wr_interrupt_late',
        status: 'completed',
      });
      return getSessionMessageState(instance.ctx.storage, 'msg_018f1e2d3c4bLateMsgAbCdEfG');
    });

    expect(result?.status).toBe('interrupted');
  });

  it('derives accepted current work health from fenced liveness deadlines', async () => {
    const userId = 'user_pending_health_fence';
    const sessionId = 'agent_pending_health_fence';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4bHealthFenceAbC',
        status: 'accepted',
        prompt: 'active',
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: 'wr_health_fence',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_health_fence',
        wrapperRunId: 'wr_health_fence',
        noOutputDeadlineAt: Date.now() + 60_000,
      });
      const healthy = await instance.getCurrentMessageWork();
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_health_fence',
        wrapperRunId: 'wr_health_fence',
        noOutputDeadlineAt: Date.now() - 1,
      });
      const stale = await instance.getCurrentMessageWork();
      return { healthy, stale };
    });

    expect(result.healthy?.health).toBe('healthy');
    expect(result.stale?.health).toBe('stale');
  });

  it('drains a pending current message while another accepted message shares the fenced wrapper run', async () => {
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
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_active_flush', instanceGeneration: 1 },
      });
      instance['physicalWrapperObserver'] = async () => ({
        status: 'present',
        observed: [
          {
            representation: 'process',
            id: 'wrapper-active-flush',
            port: 5000,
            instanceId: 'instance_active_flush',
            instanceGeneration: 1,
          },
        ],
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_active_flush',
        wrapperRunId: 'wr_active_flush',
        lastWrapperMessageAt: Date.now(),
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

      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const accepted = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        'wr_active_flush'
      );
      return { callCount, pending, accepted };
    });

    expect(result.callCount).toBe(1);
    expect(result.pending.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bActFlushTwoAbC',
    ]);
    expect(result.accepted.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bActBusyRunAbCd',
      'msg_018f1e2d3c4bActFlushOneAbC',
    ]);
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
      const startResult = await instance.admitPreparedInitialMessage(
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

  it('alarm drains the next pending message through current message acceptance', async () => {
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
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId: 'msg_018f1e2d3c4bComplNextAbCdE',
          executionId: 'exc_completion_next',
          content: 'next message',
          createdAt: 1,
        })
      );

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

  it('does not redeliver exhausted work when terminal effect processing fails once', async () => {
    const userId = 'user_pending_exhaust_repair';
    const sessionId = 'agent_pending_exhaust_repair';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      let deliveryAttempts = 0;
      (instance as any).orchestrator = {
        execute: async () => {
          deliveryAttempts += 1;
          throw new Error('wrapper unavailable');
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-exhaust-repair',
      });
      const messageId = 'msg_018f1e2d3c4bExhstRprAAAAA1';
      await putSessionMessageState(instance.ctx.storage, {
        messageId,
        status: 'queued',
        prompt: 'retry exhaust repair',
        createdAt: Date.now(),
        queuedAt: Date.now(),
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createMessage({
          messageId,
          content: 'retry exhaust repair',
          createdAt: 1,
          flushAttempts: 1,
          nextFlushAttemptAt: Date.now() - 1,
        })
      );
      const originalEnsure = (instance as any).ensureTerminalMessageEvent.bind(instance);
      let failTerminalEvent = true;
      (instance as any).ensureTerminalMessageEvent = (params: unknown) => {
        if (failTerminalEvent) {
          failTerminalEvent = false;
          throw new Error('terminal effects unavailable');
        }
        originalEnsure(params);
      };

      await instance.alarm();
      await instance.alarm();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const terminal = await getSessionMessageState(instance.ctx.storage, messageId);
      const events = createEventQueries(
        drizzle(state.storage, { logger: false }),
        state.storage.sql
      ).findByFilters({ eventTypes: ['cloud.message.failed'] });
      return { deliveryAttempts, pending, terminal, events };
    });

    expect(result.deliveryAttempts).toBe(1);
    expect(result.pending).toHaveLength(0);
    expect(result.terminal?.status).toBe('failed');
    expect(result.events).toHaveLength(1);
  });

  it('does not redeliver after exhausted pending disposition survives terminal state put failure', async () => {
    const userId = 'user_pending_exhaust_state_failure';
    const sessionId = 'agent_pending_exhaust_state_failure';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const callbacks: Array<{ payload: { messageId?: string; status: string } }> = [];
      let deliveryAttempts = 0;
      (
        instance.env as typeof instance.env & {
          CALLBACK_QUEUE: {
            send: (job: { payload: { messageId?: string; status: string } }) => Promise<void>;
          };
        }
      ).CALLBACK_QUEUE = {
        send: async job => {
          callbacks.push(job);
        },
      };
      (instance as any).orchestrator = {
        execute: async () => {
          deliveryAttempts += 1;
          throw new Error('wrapper exhaust state failure');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5',
        prompt: 'state failure exhausted prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-exhaust-state-failure',
        callbackTarget: { url: 'https://example.com/exhaust-state-failure' },
      });
      const messageId = 'msg_018f1e2d3c4bExhstStateFail';
      await instance.admitSubmittedMessage(
        queueUserMessageInput({ userId, prompt: 'state failure exhausted prompt', messageId })
      );
      const pending = (await listPendingSessionMessages(instance.ctx.storage))[0];
      if (!pending) throw new Error('Expected pending message');
      await storePendingSessionMessage(instance.ctx.storage, {
        ...pending,
        flushAttempts: 1,
        nextFlushAttemptAt: Date.now() - 1,
      });
      const originalPut = instance.ctx.storage.put.bind(instance.ctx.storage);
      let failTerminalStatePut = true;
      instance.ctx.storage.put = async (key, value) => {
        if (
          failTerminalStatePut &&
          key === `session_message:${messageId}` &&
          typeof value === 'object' &&
          value !== null &&
          'status' in value &&
          value.status === 'failed'
        ) {
          failTerminalStatePut = false;
          throw new Error('failed state put after exhaustion');
        }
        return originalPut(key, value);
      };

      await instance.alarm();
      instance.ctx.storage.put = originalPut;
      const afterFailure = await listPendingSessionMessages(instance.ctx.storage);
      await instance.alarm();
      return {
        deliveryAttempts,
        callbacks,
        afterFailure,
        pending: await listPendingSessionMessages(instance.ctx.storage),
        terminal: await getSessionMessageState(instance.ctx.storage, messageId),
      };
    });

    expect(result.deliveryAttempts).toBe(1);
    expect(result.afterFailure[0]?.deliveryDisposition).toBe('terminalization-pending');
    expect(result.pending).toHaveLength(0);
    expect(result.terminal?.status).toBe('failed');
    expect(result.callbacks).toHaveLength(1);
  });

  it('continues a partially failed multi-message interrupt without dispatching captured work', async () => {
    const userId = 'user_pending_interrupt_batch_failure';
    const sessionId = 'agent_pending_interrupt_batch_failure';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      let deliveryAttempts = 0;
      (instance as any).orchestrator = {
        execute: async () => {
          deliveryAttempts += 1;
          throw new Error('must not dispatch canceled work');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'e6e6e6e6-e6e6-4e6e-8e6e-e6e6e6e6e6e6',
        prompt: 'interrupt batch prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-interrupt-batch-failure',
      });
      const firstId = 'msg_018f1e2d3c4bIntrBatchFirst';
      const secondId = 'msg_018f1e2d3c4bIntrBatchSecnd';
      for (const [messageId, createdAt] of [
        [firstId, 1],
        [secondId, 2],
      ] as const) {
        await storePendingSessionMessage(
          instance.ctx.storage,
          createMessage({ messageId, content: messageId, createdAt })
        );
        await putSessionMessageState(instance.ctx.storage, {
          messageId,
          status: 'queued',
          prompt: messageId,
          createdAt,
          queuedAt: createdAt,
        });
      }
      const originalPut = instance.ctx.storage.put.bind(instance.ctx.storage);
      let failSecondInterrupt = true;
      instance.ctx.storage.put = async (key, value) => {
        if (
          failSecondInterrupt &&
          key === `session_message:${secondId}` &&
          typeof value === 'object' &&
          value !== null &&
          'status' in value &&
          value.status === 'interrupted'
        ) {
          failSecondInterrupt = false;
          throw new Error('second interrupted state put failed');
        }
        return originalPut(key, value);
      };

      await expect(instance.interruptExecution()).rejects.toThrow(
        'second interrupted state put failed'
      );
      instance.ctx.storage.put = originalPut;
      const anchored = await listPendingSessionMessages(instance.ctx.storage);
      await instance.alarm();
      return {
        deliveryAttempts,
        anchored,
        first: await getSessionMessageState(instance.ctx.storage, firstId),
        second: await getSessionMessageState(instance.ctx.storage, secondId),
        pending: await listPendingSessionMessages(instance.ctx.storage),
      };
    });

    expect(result.deliveryAttempts).toBe(0);
    expect(result.anchored).toHaveLength(2);
    expect(result.anchored.map(message => message.messageId)).toEqual([
      'msg_018f1e2d3c4bIntrBatchFirst',
      'msg_018f1e2d3c4bIntrBatchSecnd',
    ]);
    expect(result.first?.status).toBe('interrupted');
    expect(result.second?.status).toBe('interrupted');
    expect(result.pending).toHaveLength(0);
  });

  it('enqueues callback-required delivery exhaustion in the terminalization alarm pass', async () => {
    const userId = 'user_pending_exhaust_callback_progress';
    const sessionId = 'agent_pending_exhaust_callback_progress';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const callbacks: Array<{ payload: { messageId?: string; status: string } }> = [];
      (
        instance.env as typeof instance.env & {
          CALLBACK_QUEUE: {
            send: (job: { payload: { messageId?: string; status: string } }) => Promise<void>;
          };
        }
      ).CALLBACK_QUEUE = {
        send: async job => {
          callbacks.push(job);
        },
      };
      (instance as any).orchestrator = {
        execute: async () => {
          throw new Error('wrapper cannot accept exhausted callback');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4',
        prompt: 'callback exhausted prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-exhaust-callback-progress',
        callbackTarget: { url: 'https://example.com/exhaust-progress' },
      });
      const messageId = 'msg_018f1e2d3c4bExhstCbProgABC';
      await instance.admitSubmittedMessage(
        queueUserMessageInput({ userId, prompt: 'callback exhausted prompt', messageId })
      );
      const pending = (await listPendingSessionMessages(instance.ctx.storage))[0];
      if (!pending) throw new Error('Expected pending message');
      await storePendingSessionMessage(instance.ctx.storage, {
        ...pending,
        flushAttempts: 1,
        nextFlushAttemptAt: Date.now() - 1,
      });

      await instance.alarm();
      return {
        callbacks,
        state: await getSessionMessageState(instance.ctx.storage, messageId),
      };
    });

    expect(result.state?.status).toBe('failed');
    expect(result.callbacks).toHaveLength(1);
    expect(result.callbacks[0].payload).toMatchObject({
      messageId: 'msg_018f1e2d3c4bExhstCbProgABC',
      status: 'failed',
    });
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
          flushAttempts: 1,
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
      attempts: 2,
    });
    const failedEvent = result.events.find(
      event => event.stream_event_type === 'cloud.message.failed'
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload).toMatchObject({
      messageId: 'msg_018f1e2d3c4bExhstTrmAAAAA1',
      reason: 'exhausted',
      attempts: 2,
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

  it('rejects reuse of a failed message id and admits a fresh identity', async () => {
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
          flushAttempts: 1,
          nextFlushAttemptAt: Date.now() - 1,
        })
      );

      await instance.alarm();

      const messageState = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bRtryTrmAAAAA12'
      );

      const retryResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'retry same message',
          messageId: 'msg_018f1e2d3c4bRtryTrmAAAAA12',
        })
      );

      const terminalStateAfterRetry = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bRtryTrmAAAAA12'
      );
      const newMessageResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'new message identity',
          messageId: 'msg_018f1e2d3c4bRtryTrmBBBBB12',
        })
      );
      const newState = await getSessionMessageState(
        instance.ctx.storage,
        'msg_018f1e2d3c4bRtryTrmBBBBB12'
      );

      return { messageState, retryResult, terminalStateAfterRetry, newMessageResult, newState };
    });

    expect(result.messageState?.status).toBe('failed');
    expect(result.retryResult).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(result.terminalStateAfterRetry?.status).toBe('failed');
    expect(result.newMessageResult).toMatchObject({ success: true });
    expect(result.newState?.status).toBe('queued');
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
          flushAttempts: 1,
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
