/**
 * Phase 8: Execution-id removal tests.
 *
 * New-path messages (admitted via admitSubmittedMessage -> FencedWrapperDispatchRequest)
 * must NOT synthesize execution IDs, create execution metadata rows, or expose
 * fake execution IDs in event payloads or API responses.
 *
 * All tests follow red-green discipline: write first, confirm they fail, then
 * implement production changes to make them pass.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, it, expect, beforeEach } from 'vitest';
import { listPendingSessionMessages } from '../../../src/session/pending-messages.js';
import {
  listNonTerminalAcceptedMessages,
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import {
  allocateWrapperRuntimeState,
  getWrapperRuntimeState,
} from '../../../src/session/wrapper-runtime-state.js';
import { createEventQueries } from '../../../src/session/queries/events.js';
import type { FencedWrapperDispatchRequest } from '../../../src/execution/types.js';
import { queueUserMessageInput, registerReadySession } from '../../helpers/session-setup.js';

describe('execution-id removal - queue and start response', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    await Promise.all(ids.map(id => env.CLOUD_AGENT_SESSION.get(id).deleteSession()));
  });

  it('new-path admission result omits executionId', async () => {
    const userId = 'user_noexec_start';
    const sessionId = 'agent_noexec_start';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_noexec_start',
        kiloSessionId: '11111111-1111-4111-1111-111111111111',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-noexec-start',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'do the thing',
        messageId: 'msg_018f1e2d3c4bNoExecStartMsg',
      });

      const startResult = await instance.admitSubmittedMessage(request);
      return { startResult };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    // executionId must be absent from the start response
    expect(result.startResult).not.toHaveProperty('executionId');
    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bNoExecStartMsg');
    expect(result.startResult.outcome).toBe('queued');
  });

  it('new-path pending message persists canonical V2 intent without executionId', async () => {
    const userId = 'user_noexec_pending';
    const sessionId = 'agent_noexec_pending';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_noexec_pending',
        kiloSessionId: '22222222-2222-4222-2222-222222222222',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-noexec-pending',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'follow up',
        messageId: 'msg_018f1e2d3c4bPendNoExecIdXY',
      });

      const startResult = await instance.admitSubmittedMessage(request);
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).not.toHaveProperty('legacyExecutionId');
    expect(result.pending[0]?.intent).toEqual({
      turn: {
        type: 'prompt',
        messageId: 'msg_018f1e2d3c4bPendNoExecIdXY',
        prompt: 'follow up',
      },
      agent: { mode: 'code', model: 'test-model', variant: undefined },
      finalization: { autoCommit: undefined, condenseOnComplete: undefined },
    });
  });
});

describe('execution-id removal - flush does not create execution rows', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    await Promise.all(ids.map(id => env.CLOUD_AGENT_SESSION.get(id).deleteSession()));
  });

  it('new-path flush does not insert an execution metadata row', async () => {
    const userId = 'user_noexec_flush';
    const sessionId = 'agent_noexec_flush';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: FencedWrapperDispatchRequest | null = null;
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          capturedPlan = plan;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_flush_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_noexec_flush',
        kiloSessionId: '44444444-4444-4444-4444-444444444444',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-noexec-flush',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'do work',
        messageId: 'msg_018f1e2d3c4bNoExecFlushAbC',
      });

      const startResult = await instance.admitSubmittedMessage(request);

      // Trigger alarm to flush the pending message
      await instance.alarm();

      const executions = await instance.getExecutions();
      const pending = await listPendingSessionMessages(instance.ctx.storage);

      return { startResult, executions, pending, capturedPlan };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    // No execution metadata row should have been created
    expect(result.executions).toHaveLength(0);
    // Pending message should be flushed (no longer pending)
    expect(result.pending).toHaveLength(0);
    // But the message was still delivered to the orchestrator
    expect(result.capturedPlan).not.toBeNull();
    expect(result.capturedPlan?.turn.messageId).toBe('msg_018f1e2d3c4bNoExecFlushAbC');
    // The plan passed to the orchestrator must not contain an executionId
    expect(result.capturedPlan).not.toHaveProperty('executionId');
  });

  it('repairs accepted pending residue with one sent event and no wrapper redispatch', async () => {
    const userId = 'user_noexec_sent_repair';
    const sessionId = 'agent_noexec_sent_repair';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, doState) => {
      let dispatches = 0;
      (instance as any).orchestrator = {
        execute: async () => {
          dispatches += 1;
          throw new Error('must not redispatch accepted residue');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_noexec_sent_repair',
        kiloSessionId: '56565656-5656-4565-8565-565656565656',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-noexec-repair',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      });
      const messageId = 'msg_018f1e2d3c4bSentRepairAbCd';
      await instance.admitSubmittedMessage(
        queueUserMessageInput({ userId, prompt: 'repair me', messageId })
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId,
        status: 'accepted',
        prompt: 'repair me',
        createdAt: 1,
        queuedAt: 1,
        acceptedAt: 2,
        wrapperRunId: 'wr_accepted_repair',
      });

      await instance.alarm();
      await instance.alarm();
      const events = createEventQueries(
        drizzle(doState.storage, { logger: false }),
        doState.storage.sql
      ).findByFilters({ eventTypes: ['cloud.message.sent'] });
      return {
        dispatches,
        events,
        pending: await listPendingSessionMessages(instance.ctx.storage),
      };
    });

    expect(result.dispatches).toBe(0);
    expect(result.pending).toHaveLength(0);
    expect(result.events).toHaveLength(1);
  });

  it('retries sent-event repair from accepted pending residue without wrapper redispatch', async () => {
    const userId = 'user_noexec_sent_retry';
    const sessionId = 'agent_noexec_sent_retry';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, doState) => {
      let dispatches = 0;
      (instance as any).orchestrator = {
        execute: async () => {
          dispatches += 1;
          throw new Error('no dispatch');
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '57575757-5757-4575-8575-575757575757',
        prompt: 'initial',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-noexec-sent-retry',
      });
      const messageId = 'msg_018f1e2d3c4bSentRtryAbCdEF';
      await instance.admitSubmittedMessage(
        queueUserMessageInput({ userId, prompt: 'repair retry', messageId })
      );
      await putSessionMessageState(instance.ctx.storage, {
        messageId,
        status: 'accepted',
        prompt: 'repair retry',
        createdAt: 1,
        queuedAt: 1,
        acceptedAt: 2,
        wrapperRunId: 'wr_accepted_retry',
      });
      const realInsertUnique = instance['eventQueries'].insertUnique.bind(instance['eventQueries']);
      let failSent = true;
      instance['eventQueries'].insertUnique = params => {
        if (failSent && params.entityId === `sent-message/${messageId}`) {
          failSent = false;
          throw new Error('sent insert failed');
        }
        return realInsertUnique(params);
      };
      await instance.alarm();
      const pendingAfterFailure = await listPendingSessionMessages(instance.ctx.storage);
      await instance.alarm();
      const events = createEventQueries(
        drizzle(doState.storage, { logger: false }),
        doState.storage.sql
      ).findByFilters({ eventTypes: ['cloud.message.sent'] });
      return {
        dispatches,
        pendingAfterFailure,
        pending: await listPendingSessionMessages(instance.ctx.storage),
        events,
      };
    });

    expect(result.dispatches).toBe(0);
    expect(result.pendingAfterFailure).toHaveLength(1);
    expect(result.pending).toHaveLength(0);
    expect(result.events).toHaveLength(1);
  });

  it('new-path flush delivers message and emits queued and sent events without executionId', async () => {
    const userId = 'user_noexec_result';
    const sessionId = 'agent_noexec_result';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, doState) => {
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => ({
          messageId: plan.turn.messageId,
          kiloSessionId: 'kilo_result_test',
        }),
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_noexec_result',
        kiloSessionId: '55555555-5555-4555-5555-555555555555',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-noexec-result',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'deliver me',
        messageId: 'msg_018f1e2d3c4bResultNoExecXX',
      });

      await instance.admitSubmittedMessage(request);
      await instance.alarm();

      const wrapperState = await getWrapperRuntimeState(instance.ctx.storage);
      const acceptedMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperState.wrapperRunId
      );

      const db = drizzle(doState.storage, { logger: false });
      const eventQueries = createEventQueries(db, doState.storage.sql);
      const allEvents = eventQueries.findByFilters({});

      return { acceptedMessages, allEvents };
    });

    // The message should be accepted (sent to wrapper)
    expect(result.acceptedMessages).toHaveLength(1);
    expect(result.acceptedMessages[0]?.messageId).toBe('msg_018f1e2d3c4bResultNoExecXX');
    expect(result.acceptedMessages[0]?.status).toBe('accepted');

    // Verify message delivery events do not expose executionId in their payloads.
    const queuedEvents = result.allEvents.filter(
      e => e.stream_event_type === 'cloud.message.queued'
    );
    expect(queuedEvents.length).toBeGreaterThanOrEqual(1);
    for (const evt of queuedEvents) {
      const payload = JSON.parse(evt.payload);
      expect(payload).not.toHaveProperty('executionId');
      expect(payload.messageId).toBeTruthy();
    }

    const sentEvents = result.allEvents.filter(e => e.stream_event_type === 'cloud.message.sent');
    expect(sentEvents).toHaveLength(1);
    const sentPayload = JSON.parse(sentEvents[0]?.payload ?? '{}');
    expect(sentPayload).toMatchObject({
      messageId: 'msg_018f1e2d3c4bResultNoExecXX',
      delivery: 'sent',
    });
    expect(sentPayload).not.toHaveProperty('executionId');
  });
});

describe('execution-id removal - stream events do not expose fake executionIds', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    await Promise.all(ids.map(id => env.CLOUD_AGENT_SESSION.get(id).deleteSession()));
  });

  it('new-path message queued event payload does not contain executionId', async () => {
    const userId = 'user_stream_noexec';
    const sessionId = 'agent_stream_noexec';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, doState) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_stream_noexec',
        kiloSessionId: '66666666-6666-4666-6666-666666666666',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-stream-noexec',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'stream this',
        messageId: 'msg_018f1e2d3c4bStreamNoexec01',
      });

      await instance.admitSubmittedMessage(request);

      const db = drizzle(doState.storage, { logger: false });
      const eventQueries = createEventQueries(db, doState.storage.sql);
      const queuedEvents = eventQueries.findByFilters({
        eventTypes: ['cloud.message.queued'],
      });

      return { queuedEvents };
    });

    expect(result.queuedEvents.length).toBeGreaterThanOrEqual(1);
    for (const evt of result.queuedEvents) {
      const payload = JSON.parse(evt.payload);
      expect(payload).not.toHaveProperty('executionId');
      expect(payload.messageId).toBe('msg_018f1e2d3c4bStreamNoexec01');
    }
  });

  it('new-path message terminal events do not expose executionId in payload', async () => {
    const userId = 'user_term_noexec';
    const sessionId = 'agent_term_noexec';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, doState) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_term_noexec',
        kiloSessionId: '77777777-7777-4777-7777-777777777777',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-term-noexec',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const acceptedMsg: SessionMessageState = {
        messageId: 'msg_018f1e2d3c4bTermNoexec01AB',
        status: 'accepted',
        prompt: 'hello',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: wrapperState.wrapperRunId!,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMsg);

      await (instance as any).terminalizeSessionMessageOnce('msg_018f1e2d3c4bTermNoexec01AB', {
        kind: 'completed',
        completionSource: 'assistant_message_event',
        assistantMessageId: 'assistant_msg_001',
      });

      const db = drizzle(doState.storage, { logger: false });
      const eventQueries = createEventQueries(db, doState.storage.sql);
      const terminalEvents = eventQueries.findByFilters({
        eventTypes: ['cloud.message.completed', 'cloud.message.failed'],
      });

      return { terminalEvents };
    });

    const completedEvents = result.terminalEvents.filter(
      e => e.stream_event_type === 'cloud.message.completed'
    );
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
    for (const evt of completedEvents) {
      const payload = JSON.parse(evt.payload);
      expect(payload).not.toHaveProperty('executionId');
      expect(payload.messageId).toBe('msg_018f1e2d3c4bTermNoexec01AB');
      expect(payload.status).toBe('completed');
    }
  });

  it('new-path pending message interrupted event does not expose executionId when absent', async () => {
    const userId = 'user_intrpt_noex';
    const sessionId = 'agent_intrpt_noex';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, doState) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_intrpt_noex',
        kiloSessionId: '88888888-8888-4888-8888-888888888888',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-intrpt-noex',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'interrupt me',
        messageId: 'msg_018f1e2d3c4bIntrptNoexecAB',
      });
      const startResult = await instance.admitSubmittedMessage(request);
      if (!startResult.success) {
        throw new Error(`admitSubmittedMessage failed: ${JSON.stringify(startResult)}`);
      }

      // Trigger interrupt which clears pending messages
      await instance.interruptExecution();

      const db = drizzle(doState.storage, { logger: false });
      const eventQueries = createEventQueries(db, doState.storage.sql);
      const failedEvents = eventQueries.findByFilters({
        eventTypes: ['cloud.message.failed'],
      });

      return { failedEvents };
    });

    const interruptEvents = result.failedEvents.filter(e => {
      const payload = JSON.parse(e.payload);
      return payload.completionSource === 'interrupt';
    });
    expect(interruptEvents.length).toBeGreaterThanOrEqual(1);
    for (const evt of interruptEvents) {
      const payload = JSON.parse(evt.payload);
      expect(payload).not.toHaveProperty('executionId');
      expect(payload.messageId).toBe('msg_018f1e2d3c4bIntrptNoexecAB');
      expect(payload.error).toContain('interrupted');
    }
  });
});

describe('execution-id removal - ingest does not alias wrapperRunId as execution_id', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    await Promise.all(ids.map(id => env.CLOUD_AGENT_SESSION.get(id).deleteSession()));
  });

  it('new-path ingest events do not use wrapperRunId as execution_id in StoredEvent', async () => {
    const userId = 'user_ingest_noexec';
    const sessionId = 'agent_ingest_noexec';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, doState) => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_ingest_noexec',
        kiloSessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-ingest-noexec',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const wrapperRunId = wrapperState.wrapperRunId!;

      const accessPrivate = instance as any;
      accessPrivate.insertAndBroadcastEvent({
        executionId: '' as any,
        sessionId: 'agent_ingest_noexec',
        streamEventType: 'kilocode',
        payload: JSON.stringify({
          event: 'message.updated',
          messageId: 'assistant_msg_002',
          message: {
            content: [{ type: 'text', text: 'hello world' }],
            model: 'test-model',
            role: 'assistant',
          },
        }),
        timestamp: Date.now(),
      });

      const db = drizzle(doState.storage, { logger: false });
      const eventQueries = createEventQueries(db, doState.storage.sql);
      const allEvents = eventQueries.findByFilters({});

      return { allEvents, wrapperRunId };
    });

    const kilocodeEvents = result.allEvents.filter(e => e.stream_event_type === 'kilocode');
    expect(kilocodeEvents.length).toBeGreaterThanOrEqual(1);
    for (const evt of kilocodeEvents) {
      expect(evt.execution_id).not.toBe(result.wrapperRunId);
    }
  });
});
