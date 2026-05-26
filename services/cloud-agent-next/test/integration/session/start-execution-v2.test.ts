/**
 * Integration tests for DO-orchestrated V2 execution start.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  createPendingSessionMessage,
  listPendingSessionMessages,
  storePendingSessionMessage,
} from '../../../src/session/pending-messages.js';
import { listNonTerminalAcceptedMessages } from '../../../src/session/session-message-state.js';
import {
  groupedRegisterSessionInput,
  queueRegisteredInitialInput,
  queueUserMessageInput,
  registerReadySession,
} from '../../helpers/session-setup.js';

describe('CloudAgentSession message admission', () => {
  it('admits the already accepted initial turn through grouped session creation', async () => {
    const userId = 'user_grouped_start' as const;
    const sessionId = 'agent_grouped_start' as const;
    const messageId = 'msg_018f1e2d3c4bInitMsgAbCdEfG';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      const admitted = await instance.createSessionWithInitialAdmission({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'admit my first turn',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '11111111-1111-4111-9111-111111111111',
          kilocodeToken: 'token-grouped-start',
        }),
        message: {
          initialTurn: {
            type: 'prompt',
            messageId,
            prompt: 'admit my first turn',
          },
        },
      });
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const metadata = await instance.getMetadata();
      return { admitted, pending, metadata };
    });

    expect(result.admitted).toMatchObject({
      success: true,
      messageId,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      compatibilityDelivery: 'queued',
    });
    expect(result.metadata?.initialMessage?.id).toBe(messageId);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(messageId);
    expect(result.pending[0]?.content).toBe('admit my first turn');
  });

  it('surfaces initial admission failure after retaining registered DO metadata', async () => {
    const userId = 'user_grouped_start_failure' as const;
    const sessionId = 'agent_grouped_start_failure' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      for (let index = 0; index < 10; index++) {
        await storePendingSessionMessage(
          instance.ctx.storage,
          createPendingSessionMessage({
            messageId: `msg_018f1e2d3c4b${String(index).padStart(14, 'A')}`,
            role: 'user',
            content: `existing pending ${index}`,
            createdAt: index,
          })
        );
      }
      const admitted = await instance.createSessionWithInitialAdmission({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'reject this admission',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '12121212-1212-4212-9212-121212121212',
          kilocodeToken: 'token-grouped-start-failure',
        }),
        message: {
          initialTurn: {
            type: 'prompt',
            messageId: 'msg_018f1e2d3c4bOverMsgAbCdEfG',
            prompt: 'reject this admission',
          },
        },
      });
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const metadata = await instance.getMetadata();
      return { admitted, pending, metadata };
    });

    expect(result.admitted).toMatchObject({ success: false, code: 'PENDING_QUEUE_FULL' });
    expect(result.metadata?.identity.sessionId).toBe(sessionId);
    expect(result.pending).toHaveLength(10);
    expect(result.pending.some(message => message.content === 'reject this admission')).toBe(false);
  });

  it('replays a retried grouped admission with the same canonical initial message identity', async () => {
    const userId = 'user_grouped_start_retry' as const;
    const sessionId = 'agent_grouped_start_retry' as const;
    const messageId = 'msg_018f1e2d3c4bBoundMsgAbCdEf';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);
    const input = {
      ...groupedRegisterSessionInput({
        sessionId,
        userId,
        prompt: 'retry grouped admission',
        mode: 'code',
        model: 'test-model',
        kiloSessionId: '13131313-1313-4313-9313-131313131313',
        kilocodeToken: 'token-grouped-start-retry',
      }),
      message: {
        initialTurn: {
          type: 'prompt' as const,
          messageId,
          prompt: 'retry grouped admission',
        },
      },
    };

    const result = await runInDurableObject(stub, async instance => {
      const first = await instance.createSessionWithInitialAdmission(input);
      const second = await instance.createSessionWithInitialAdmission(input);
      return { first, second, pending: await listPendingSessionMessages(instance.ctx.storage) };
    });

    expect(result.first).toMatchObject({ success: true, messageId, outcome: 'queued' });
    expect(result.second).toEqual(result.first);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(messageId);
  });

  it('rejects a grouped replay that changes the immutable initial intent', async () => {
    const userId = 'user_grouped_start_mismatch' as const;
    const sessionId = 'agent_grouped_start_mismatch' as const;
    const messageId = 'msg_018f1e2d3c4bMismatAbCdEfGh';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      const original = {
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'original prompt',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '14141414-1414-4414-9414-141414141414',
          kilocodeToken: 'token-grouped-start-mismatch',
        }),
        message: {
          initialTurn: { type: 'prompt' as const, messageId, prompt: 'original prompt' },
        },
      };
      const first = await instance.createSessionWithInitialAdmission(original);
      const replay = await instance.createSessionWithInitialAdmission({
        ...original,
        message: {
          initialTurn: { type: 'prompt', messageId, prompt: 'different prompt' },
        },
        agent: { ...original.agent, model: 'different-model' },
      });
      return { first, replay, pending: await listPendingSessionMessages(instance.ctx.storage) };
    });

    expect(result.first).toMatchObject({ success: true, messageId, outcome: 'queued' });
    expect(result.replay).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.content).toBe('original prompt');
    expect(result.pending[0]?.intent?.agent.model).toBe('test-model');
  });

  it('persists repaired DIND devcontainer workspace readiness metadata', async () => {
    const userId = 'user_devcontainer_ready' as const;
    const sessionId = 'agent_devcontainer_ready' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);
    const devcontainer = {
      workspacePath: '/workspace/user/sessions/agent_devcontainer_ready',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    };

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'prepare devcontainer',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '19191919-1919-4919-9919-191919191919',
          kilocodeToken: 'token-devcontainer',
        })
      );

      const ready = await instance.recordSessionReady({
        workspacePath: devcontainer.workspacePath,
        sandboxId: 'dind-abcdef',
        sessionHome: '/home/agent_devcontainer_ready',
        branchName: 'session/agent_devcontainer_ready',
        kiloSessionId: '19191919-1919-4919-9919-191919191919',
        devcontainer,
      });
      const metadata = await instance.getMetadata();
      return { ready, metadata };
    });

    expect(result.ready.success).toBe(true);
    expect(result.metadata?.workspace?.sandboxId).toBe('dind-abcdef');
    expect(result.metadata?.devcontainer).toEqual(devcontainer);
  });

  it('drains prepared devcontainer sessions with their persisted DIND workspace plan', async () => {
    const userId = 'user_devcontainer_plan' as const;
    const sessionId = 'agent_devcontainer_plan' as const;
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

      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'prepare devcontainer execution',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '20202020-2020-4020-9020-202020202020',
          kilocodeToken: 'token-devcontainer',
        }),
        workspace: {
          sandboxId: 'dind-abcdef',
          devcontainerRequested: true,
        },
      });
      await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'prepare devcontainer execution',
          messageId: 'msg_018f1e2d3c4bDevPlanAbCdEFG',
        })
      );
      await instance.alarm();
      return { capturedPlan };
    });

    expect(result.capturedPlan).toMatchObject({
      workspace: {
        sandboxId: 'dind-abcdef',
        metadata: {
          workspace: {
            sandboxId: 'dind-abcdef',
            devcontainerRequested: true,
          },
        },
      },
    });
  });

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

      const startResult = await instance.admitSubmittedMessage(request);
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.outcome).toBe('queued');
    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bInitMsgAbCdEfG');
    expect(result.plan).toBeNull();
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bInitMsgAbCdEfG');
  });

  // Initial-session workspace prep now runs lazily when the queued message is flushed.

  it('queues follow-up without calling orchestrator inline', async () => {
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
      });

      const startResult = await instance.admitSubmittedMessage(request);
      const metadata = await instance.getMetadata();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, metadata, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bAbCdEfGhIjKlMn');
    expect(result.startResult.outcome).toBe('queued');
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

      const startResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'followup prompt',
          mode: 'plan',
          model: 'queued-model',
          variant: 'beta',
          autoCommit: true,
          condenseOnComplete: true,
          messageId: 'msg_018f1e2d3c4bQueueOptAbCdEf',
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
    expect(result.startResult.outcome).toBe('queued');
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
        metadata: expect.objectContaining({
          repository: expect.objectContaining({ token: 'old-token' }),
        }),
      },
    });
    expect(result.capturedPlan.workspace).not.toHaveProperty('repositoryAuthOverrides');
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

      const startResult = await instance.admitSubmittedMessage(request);
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

      const startResult = await instance.admitSubmittedMessage(request);
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bBoundMsgAbCdEf');
    expect(result.startResult.outcome).toBe('queued');
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
        await instance.admitSubmittedMessage(
          queueUserMessageInput({
            userId,
            prompt: `queued ${index}`,
            messageId: `msg_018f1e2d3c4b${String(index).padStart(14, 'A')}`,
          })
        );
      }

      const overflowResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queued overflow',
          messageId: 'msg_018f1e2d3c4bOverMsgAbCdEfG',
        })
      );
      const metadata = await instance.getMetadata();
      const duplicateResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queued 0',
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
    expect(result.duplicateResult.outcome).toBe('queued');
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

      const startResult = await instance.admitPreparedInitialMessage(
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
    expect(result.startResult.outcome).toBe('queued');
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

      const firstResult = await instance.admitPreparedInitialMessage(
        queueRegisteredInitialInput({ userId })
      );
      const retryResult = await instance.admitPreparedInitialMessage(
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

      const startResult = await instance.admitPreparedInitialMessage(
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

  it('replays a prepared initial command turn when initiate queues registered initial work', async () => {
    const userId = 'user_exec_prepared_command' as const;
    const sessionId = 'agent_exec_prepared_command' as const;
    const initialMessageId = 'msg_018f1e2d3c4bPrepCmdXAbCdEF';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '18181818-1818-4818-9818-181818181818',
        prompt: '/compact --aggressive',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-prepared',
        initialMessageId,
        initialTurn: {
          type: 'command',
          command: 'compact',
          arguments: '--aggressive',
        },
      });

      const startResult = await instance.admitPreparedInitialMessage(
        queueRegisteredInitialInput({ userId })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe(initialMessageId);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({
      messageId: initialMessageId,
      content: '/compact --aggressive',
      intent: {
        turn: {
          type: 'command',
          messageId: initialMessageId,
          command: 'compact',
          arguments: '--aggressive',
        },
      },
    });
  });

  it('queues follow-up for later drain while current fenced wrapper work exists', async () => {
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
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn-active-followup',
        wrapperRunId: 'wr-active-followup',
      });

      const startResult = await instance.admitSubmittedMessage(
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
    expect(result.startResult.outcome).toBe('queued');
    expect(result.callCount).toBe(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bActQueAbCdEfGh');
  });

  it('returns durable admission idempotently when retrying an accepted messageId', async () => {
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
      await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'accept once',
          messageId: 'msg_018f1e2d3c4bActRetAbCdEfGh',
        })
      );
      await instance.alarm();
      const retryResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'accept once',
          messageId: 'msg_018f1e2d3c4bActRetAbCdEfGh',
        })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { retryResult, pending, callCount };
    });

    expect(result.retryResult.success).toBe(true);
    if (!result.retryResult.success) return;
    expect(result.retryResult.outcome).toBe('queued');
    expect(result.retryResult.compatibilityDelivery).toBe('sent');
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

      const startResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'bad model',
          model: '',
          messageId: 'msg_018f1e2d3c4bInvModAbCdEfGh',
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
