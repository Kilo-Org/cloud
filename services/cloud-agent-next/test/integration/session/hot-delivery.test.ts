/**
 * Phase 9: Hot delivery and wrapper lifecycle tests.
 *
 * - DO-level: queued follow-ups hot-deliver to a current warm wrapper.
 * - Wrapper-level: message.completed events advance wrapper message state.
 * - Wrapper-level: drain doesn't close over a newly accepted prompt.
 *
 * All tests follow red-green discipline.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, it, expect, beforeEach } from 'vitest';
import { listPendingSessionMessages } from '../../../src/session/pending-messages.js';
import {
  createPendingSessionMessage,
  storePendingSessionMessage,
} from '../../../src/session/pending-messages.js';
import {
  listNonTerminalAcceptedMessages,
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import {
  allocateWrapperRuntimeState,
  recordMeaningfulWrapperOutput,
} from '../../../src/session/wrapper-runtime-state.js';
import type { FencedWrapperDispatchRequest } from '../../../src/execution/types.js';
import { registerReadySession } from '../../helpers/session-setup.js';

describe('hot delivery — DO integration', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    expect(ids).toHaveLength(0);
  });

  it('queued follow-up hot-delivers to a warm wrapper', async () => {
    const userId = 'user_hot_deliv';
    const sessionId = 'agent_hot_deliv';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const followUpMessageId = 'msg_018f1e2d3c4bHotDeliv0001Ab';

    const result = await runInDurableObject(stub, async instance => {
      const capturedPlans: FencedWrapperDispatchRequest[] = [];
      (instance as any).orchestrator = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          capturedPlans.push(plan);
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_hot_test' };
        },
      };
      (instance as any).physicalWrapperObserver = async () => ({
        status: 'present',
        observed: [
          {
            representation: 'process',
            id: 'wrapper-hot',
            port: 4_173,
            instanceId: 'instance_hot',
            instanceGeneration: 1,
          },
        ],
      });

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_hot_deliv',
        kiloSessionId: '11111111-1111-4111-1111-111111111111',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-hot-deliv',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      });

      // Simulate a warm, physically owned wrapper with recent output.
      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_hot', instanceGeneration: 1 },
      });
      await recordMeaningfulWrapperOutput(
        instance.ctx.storage,
        wrapperState.wrapperGeneration,
        wrapperState.wrapperConnectionId!,
        Date.now()
      );

      // Add an accepted message so hasCurrentWrapper is true
      const acceptedMsg: SessionMessageState = {
        messageId: 'msg_018f1e2d3c4b51XzJAKpDg7ewt',
        status: 'accepted',
        prompt: 'running task',
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: wrapperState.wrapperRunId!,
      };
      await putSessionMessageState(instance.ctx.storage, acceptedMsg);

      // Queue a follow-up message
      const pendingMsg = createPendingSessionMessage({
        messageId: followUpMessageId,
        role: 'user',
        content: 'follow up prompt',
        createdAt: 1,
      });
      await storePendingSessionMessage(instance.ctx.storage, pendingMsg);

      // Flush via alarm — should hot-deliver because wrapper is warm
      await instance.alarm();

      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const acceptedMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperState.wrapperRunId!
      );
      const executions = await instance.getExecutions();

      return { capturedPlans, pending, acceptedMessages, executions };
    });

    // Follow-up message was delivered (orchestrator received the plan)
    expect(result.capturedPlans.length).toBeGreaterThanOrEqual(1);
    const deliveredPlan = result.capturedPlans.find(
      plan => plan.turn.messageId === followUpMessageId
    );
    expect(deliveredPlan).not.toBeUndefined();
    expect(deliveredPlan?.turn.messageId).toBe(followUpMessageId);

    // Phase 5 Slice 2: warm-followup flush plan has no executionId
    expect(deliveredPlan).not.toHaveProperty('executionId');

    // Phase 5 Slice 2: warm-followup flush does not create an execution row
    expect(result.executions).toHaveLength(0);

    // Pending queue is drained
    expect(result.pending).toHaveLength(0);

    // Both messages are now accepted
    expect(result.acceptedMessages.length).toBeGreaterThanOrEqual(1);
    expect(result.acceptedMessages.map(m => m.messageId)).toContain(followUpMessageId);
  });
});
