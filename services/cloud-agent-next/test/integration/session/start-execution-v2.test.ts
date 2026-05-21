/**
 * Integration tests for DO-orchestrated V2 execution start.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { listPendingSessionMessages } from '../../../src/session/pending-messages.js';
import { listNonTerminalAcceptedMessages } from '../../../src/session/session-message-state.js';
import {
  queueRegisteredInitialInput,
  queueUserMessageInput,
  registerReadySession,
} from '../../helpers/session-setup.js';

describe('CloudAgentSession.queueSessionMessage', () => {
  it('queues initiate when direct wrapper acceptance is unavailable', async () => {
    const userId = 'user_exec_plan' as const;
    const sessionId = 'agent_exec_plan' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.executionId, kiloSessionId: 'kilo_test' };
        },
      };

      const now = Date.now();
      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'do the thing',
        mode: 'code',
        model: 'test-model',
        messageId: 'msg_018f1e2d3c4bInitMsgAbCdEfG',
      });

      const startResult = await instance.queueSessionMessage(request);
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.delivery).toBe('queued');
    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bInitMsgAbCdEfG');
    expect(result.plan).toBeNull();
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bInitMsgAbCdEfG');
  });

  // Initial-session workspace prep now runs lazily when the queued message is flushed.

  it('queues follow-up and applies token overrides without calling orchestrator inline', async () => {
    const userId = 'user_exec_followup' as const;
    const sessionId = 'agent_exec_followup' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.executionId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '88888888-8888-4888-8888-888888888888',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'followup prompt',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        tokenOverrides: {
          gitToken: 'new-token',
        },
      });

      const startResult = await instance.queueSessionMessage(request);
      const metadata = await instance.getMetadata();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, metadata, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.status).toBe('started');
    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bAbCdEfGhIjKlMn');
    expect(result.startResult.delivery).toBe('queued');
    expect(result.metadata?.repository?.token).toBe('old-token');
    expect(result.plan).toBeNull();
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bAbCdEfGhIjKlMn');
    expect(result.pending[0]?.content).toBe('followup prompt');
    expect(result.pending[0]?.executionId).toBe(result.startResult.executionId);
  });

  it('flushes queued follow-up using the originally queued execution options', async () => {
    const userId = 'user_exec_followup_options' as const;
    const sessionId = 'agent_exec_followup_options' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_options',
        kiloSessionId: '78787878-7878-4878-8878-787878787878',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'default-model',
        variant: 'alpha',
        autoCommit: false,
        condenseOnComplete: false,
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const startResult = await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'followup prompt',
          mode: 'plan',
          model: 'queued-model',
          variant: 'beta',
          autoCommit: true,
          condenseOnComplete: true,
          messageId: 'msg_018f1e2d3c4bQueueOptAbCdEf',
          tokenOverrides: {
            gitToken: 'queued-git-token',
          },
        })
      );
      const pendingBeforeAlarm = await listPendingSessionMessages(instance.ctx.storage);

      await instance.alarm();

      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const metadata = await instance.getMetadata();
      const acceptedMessages = await listNonTerminalAcceptedMessages(instance.ctx.storage);
      return {
        startResult,
        capturedPlan,
        pendingBeforeAlarm,
        pending,
        metadata,
        acceptedMessages,
      };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.pendingBeforeAlarm).toHaveLength(1);
    expect(result.startResult.delivery).toBe('queued');
    expect(result.pending).toHaveLength(0);
    expect(result.metadata?.repository?.token).toBe('old-token');
    expect(result.acceptedMessages).toHaveLength(1);
    expect(result.acceptedMessages[0]?.messageId).toBe('msg_018f1e2d3c4bQueueOptAbCdEf');
    expect(result.capturedPlan).toMatchObject({
      turn: {
        prompt: 'followup prompt',
        messageId: 'msg_018f1e2d3c4bQueueOptAbCdEf',
      },
      agent: {
        mode: 'plan',
        model: 'queued-model',
        variant: 'beta',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: true,
      },
      workspace: {
        repositoryAuthOverrides: {
          gitToken: 'queued-git-token',
        },
        metadata: expect.objectContaining({
          repository: expect.objectContaining({ token: 'old-token' }),
        }),
      },
    });
  });

  it('returns BAD_REQUEST for invalid direct messageId', async () => {
    const userId = 'user_exec_bad_message_id' as const;
    const sessionId = 'agent_exec_bad_message_id' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '77777777-7777-4777-7777-777777777777',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'followup prompt',
        messageId: 'msg_018F1e2d3c4bAbCdEfGhIjKlMn',
      });

      const startResult = await instance.queueSessionMessage(request);
      return { startResult, plan: capturedPlan };
    });

    expect(result.startResult.success).toBe(false);
    if (result.startResult.success) return;

    expect(result.startResult.code).toBe('BAD_REQUEST');
    expect(result.startResult.error).toContain('messageId must match msg_');
    expect(result.plan).toBeNull();
  });

  it('uses the boundary-generated messageId for follow-up execution', async () => {
    const userId = 'user_exec_fallback' as const;
    const sessionId = 'agent_exec_fallback' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '99999999-9999-4999-9999-999999999999',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'followup prompt',
        messageId: 'msg_018f1e2d3c4bBoundMsgAbCdEf',
      });

      const startResult = await instance.queueSessionMessage(request);
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bBoundMsgAbCdEf');
    expect(result.startResult.delivery).toBe('queued');
    expect(result.plan).toBeNull();
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bBoundMsgAbCdEf');
  });

  it('enforces the pending queue limit without storing an eleventh message', async () => {
    const userId = 'user_exec_queue_full' as const;
    const sessionId = 'agent_exec_queue_full' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '66666666-6666-4666-6666-666666666666',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      for (let index = 0; index < 10; index++) {
        await instance.queueSessionMessage(
          queueUserMessageInput({
            userId,
            prompt: `queued ${index}`,
            messageId: `msg_018f1e2d3c4b${String(index).padStart(14, 'A')}`,
          })
        );
      }

      const overflowResult = await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queued overflow',
          messageId: 'msg_018f1e2d3c4bOverMsgAbCdEfG',
          tokenOverrides: {
            gitToken: 'should-not-persist',
          },
        })
      );
      const metadata = await instance.getMetadata();
      const duplicateResult = await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'duplicate queued 0',
          messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAA0',
        })
      );
      const metadataAfterDuplicate = await instance.getMetadata();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { overflowResult, duplicateResult, metadata, metadataAfterDuplicate, pending };
    });

    expect(result.overflowResult.success).toBe(false);
    if (result.overflowResult.success) return;

    expect(result.overflowResult.code).toBe('PENDING_QUEUE_FULL');
    expect(result.metadata?.repository?.token).toBe('old-token');
    expect(result.duplicateResult.success).toBe(true);
    if (!result.duplicateResult.success) return;
    expect(result.duplicateResult.delivery).toBe('queued');
    expect(result.duplicateResult.messageId).toBe('msg_018f1e2d3c4bAAAAAAAAAAAAA0');
    expect(result.metadataAfterDuplicate?.repository?.token).toBe('old-token');
    expect(result.pending).toHaveLength(10);
    expect(
      result.pending.some(message => message.messageId === 'msg_018f1e2d3c4bOverMsgAbCdEfG')
    ).toBe(false);
  });

  it('queues a prepared-session message without tripping on stale runtime state', async () => {
    const userId = 'user_exec_prepared_stale_active' as const;
    const sessionId = 'agent_exec_prepared_stale_active' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

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
        kiloSessionId: '15151515-1515-4515-9515-151515151515',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-prepared',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
        initialMessageId: 'msg_018f1e2d3c4bPrepStaleAbCdE',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', { wrapperGeneration: 99 });

      const startResult = await instance.queueSessionMessage(
        queueRegisteredInitialInput({ userId })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return {
        startResult,
        pending,
        callCount,
        executions: await instance.getExecutions(),
      };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;
    expect(result.startResult.delivery).toBe('queued');
    expect(result.callCount).toBe(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bPrepStaleAbCdE');
  });

  it('reuses prepared initialMessageId for registered-initial queueing', async () => {
    const userId = 'user_exec_prepared_initial_id' as const;
    const sessionId = 'agent_exec_prepared_initial_id' as const;
    const initialMessageId = 'msg_018f1e2d3c4bPrepInitAbCdEF';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '16161616-1616-4616-9616-161616161616',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-prepared',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
        initialMessageId,
      });

      const firstResult = await instance.queueSessionMessage(
        queueRegisteredInitialInput({ userId })
      );
      const retryResult = await instance.queueSessionMessage(
        queueRegisteredInitialInput({ userId })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { firstResult, retryResult, pending };
    });

    expect(result.firstResult.success).toBe(true);
    expect(result.retryResult.success).toBe(true);
    if (!result.firstResult.success || !result.retryResult.success) return;

    expect(result.firstResult.messageId).toBe(initialMessageId);
    expect(result.retryResult.messageId).toBe(initialMessageId);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(initialMessageId);
    expect(result.pending[0]?.content).toBe('prepared prompt');
  });

  it('uses the prepared initialMessageId for registered-initial queueing', async () => {
    const userId = 'user_exec_prepared_id_wins' as const;
    const sessionId = 'agent_exec_prepared_id_wins' as const;
    const initialMessageId = 'msg_018f1e2d3c4bPrepWinsAbCdEF';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '17171717-1717-4717-9717-171717171717',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-prepared',
        initialMessageId,
      });

      const startResult = await instance.queueSessionMessage(
        queueRegisteredInitialInput({ userId })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe(initialMessageId);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(initialMessageId);
  });

  it('queues follow-up while runtime is busy without calling orchestrator inline', async () => {
    const userId = 'user_exec_active_followup' as const;
    const sessionId = 'agent_exec_active_followup' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

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
        kiloSessionId: '12121212-1212-4212-9212-121212121212',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await instance.addExecution({
        executionId: 'exc_active_followup',
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: 'exc_active_followup',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn-active-followup',
        wrapperExecutionId: 'exc_active_followup',
        acceptedMessageId: 'msg_018f1e2d3c4bBusyRunAbCdEfG',
        acceptedExecutionId: 'exc_active_followup',
      });

      const startResult = await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queue while active',
          messageId: 'msg_018f1e2d3c4bActQueAbCdEfGh',
        })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, pending, callCount };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;
    expect(result.startResult.delivery).toBe('queued');
    expect(result.callCount).toBe(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bActQueAbCdEfGh');
  });

  it('returns sent idempotently when retrying an active accepted messageId', async () => {
    const userId = 'user_exec_active_retry' as const;
    const sessionId = 'agent_exec_active_retry' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

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
        kiloSessionId: '13131313-1313-4313-9313-131313131313',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'accept once',
          messageId: 'msg_018f1e2d3c4bActRetAbCdEfGh',
        })
      );
      await instance.alarm();
      const retryResult = await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'accept once retry',
          messageId: 'msg_018f1e2d3c4bActRetAbCdEfGh',
        })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { retryResult, pending, callCount };
    });

    expect(result.retryResult.success).toBe(true);
    if (!result.retryResult.success) return;
    expect(result.retryResult.delivery).toBe('sent');
    expect(result.pending).toHaveLength(0);
    expect(result.callCount).toBe(1);
  });

  it('does not persist token overrides when model validation fails', async () => {
    const userId = 'user_exec_invalid_model' as const;
    const sessionId = 'agent_exec_invalid_model' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '14141414-1414-4414-9414-141414141414',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const startResult = await instance.queueSessionMessage(
        queueUserMessageInput({
          userId,
          prompt: 'bad model',
          model: '',
          messageId: 'msg_018f1e2d3c4bInvModAbCdEfGh',
          tokenOverrides: {
            gitToken: 'should-not-persist',
          },
        })
      );
      const metadata = await instance.getMetadata();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, metadata, pending };
    });

    expect(result.startResult.success).toBe(false);
    if (result.startResult.success) return;
    expect(result.startResult.code).toBe('BAD_REQUEST');
    expect(result.metadata?.repository?.token).toBe('old-token');
    expect(result.pending).toHaveLength(0);
  });
});
