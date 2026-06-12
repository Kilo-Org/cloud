/**
 * Phase 9: Hot delivery and wrapper lifecycle tests.
 *
 * - DO-level: queued follow-ups hot-deliver to a current warm wrapper.
 * - Wrapper-level: message.completed events advance wrapper message state.
 * - Wrapper-level: drain doesn't close over a newly accepted prompt.
 *
 * All tests follow red-green discipline.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';
import { listPendingSessionMessages } from '../../../src/session/pending-messages.js';
import {
  createPendingSessionMessage,
  storePendingSessionMessage,
} from '../../../src/session/pending-messages.js';
import {
  getSessionMessageState,
  listNonTerminalAcceptedMessages,
  putSessionMessageState,
  type SessionMessageState,
} from '../../../src/session/session-message-state.js';
import {
  allocateWrapperRuntimeState,
  getWrapperRuntimeState,
  markWrapperFinalizing,
  recordMeaningfulWrapperOutput,
} from '../../../src/session/wrapper-runtime-state.js';
import type { FencedWrapperDispatchRequest } from '../../../src/execution/types.js';
import { registerReadySession } from '../../helpers/session-setup.js';

describe('hot delivery — DO integration', () => {
  it('holds a queued follow-up while the current wrapper run finalizes', async () => {
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
      await markWrapperFinalizing(instance.ctx.storage, wrapperState.wrapperRunId);

      // Queue a follow-up message
      const pendingMsg = createPendingSessionMessage({
        messageId: followUpMessageId,
        role: 'user',
        content: 'follow up prompt',
        createdAt: 1,
      });
      await storePendingSessionMessage(instance.ctx.storage, pendingMsg);

      // Flush via alarm — finalizing must hold the pending message without retry churn.
      await instance.alarm();
      const runtimeAfterDelivery = await getWrapperRuntimeState(instance.ctx.storage);

      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const acceptedMessages = await listNonTerminalAcceptedMessages(
        instance.ctx.storage,
        wrapperState.wrapperRunId!
      );
      const executions = await instance.getExecutions();

      return { capturedPlans, pending, acceptedMessages, executions, runtimeAfterDelivery };
    });

    expect(result.capturedPlans).toHaveLength(0);
    expect(result.executions).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(followUpMessageId);
    expect(result.pending[0]?.flushAttempts).toBeUndefined();
    expect(result.runtimeAfterDelivery.finalizingWrapperRunId).toBe(
      result.runtimeAfterDelivery.wrapperRunId
    );
    expect(result.acceptedMessages.map(message => message.messageId)).not.toContain(
      followUpMessageId
    );
  });

  it('normal wrapper completion releases the finalizing hold and drains one follow-up under a fresh run', async () => {
    const userId = 'user_complete_drain';
    const sessionId = 'agent_complete_drain';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const currentMessageId = 'msg_018f1e2d3c4bCmplteDrain001';
    const followUpMessageId = 'msg_018f1e2d3c4bCmplteDrain002';

    const result = await runInDurableObject(stub, async instance => {
      const capturedPlans: FencedWrapperDispatchRequest[] = [];
      instance['orchestrator'] = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          capturedPlans.push(plan);
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_complete_drain' };
        },
      };
      instance['physicalWrapperObserver'] = async () => ({
        status: 'present' as const,
        observed: [
          {
            representation: 'process' as const,
            id: 'wrapper-complete-drain',
            port: 4_173,
            instanceId: 'instance_complete_drain',
            instanceGeneration: 1,
          },
        ],
      });

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_complete_drain',
        kiloSessionId: '33333333-3333-4333-8333-333333333333',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-complete-drain',
      });

      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_complete_drain', instanceGeneration: 1 },
      });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: currentMessageId,
        status: 'accepted',
        prompt: '/status',
        admissionSnapshot: {
          turn: { type: 'command', messageId: currentMessageId, command: 'status', arguments: '' },
          agent: { mode: 'code', model: 'test-model' },
        },
        createdAt: 1,
        acceptedAt: 1,
        wrapperRunId: wrapperState.wrapperRunId,
      });
      await markWrapperFinalizing(instance.ctx.storage, wrapperState.wrapperRunId);
      await storePendingSessionMessage(
        instance.ctx.storage,
        createPendingSessionMessage({
          messageId: followUpMessageId,
          role: 'user',
          content: 'follow up after normal completion',
          createdAt: 2,
        })
      );

      await instance.alarm();
      const plansBeforeComplete = capturedPlans.length;
      await instance.handleWrapperTerminalEvent({
        wrapperRunId: wrapperState.wrapperRunId,
        status: 'completed',
        messageIds: [currentMessageId],
      });
      const runtimeAfterComplete = await getWrapperRuntimeState(instance.ctx.storage);
      await instance.alarm();
      await instance.alarm();

      return {
        currentWrapperRunId: wrapperState.wrapperRunId,
        plansBeforeComplete,
        capturedPlans,
        runtimeAfterComplete,
        remaining: await listPendingSessionMessages(instance.ctx.storage),
        currentMessage: await getSessionMessageState(instance.ctx.storage, currentMessageId),
      };
    });

    const followUpPlans = result.capturedPlans.filter(
      plan => plan.turn.messageId === followUpMessageId
    );
    expect(result.plansBeforeComplete).toBe(0);
    expect(result.currentMessage).toMatchObject({
      status: 'completed',
      completionSource: 'idle_reconciliation',
    });
    expect(result.runtimeAfterComplete.finalizingWrapperRunId).toBeUndefined();
    expect(followUpPlans).toHaveLength(1);
    expect(followUpPlans[0]?.wrapper.fence.wrapperRunId).not.toBe(result.currentWrapperRunId);
    expect(result.remaining).toHaveLength(0);
  });

  it('holds pending delivery through physical cleanup and drains after confirmed absence', async () => {
    const userId = 'user_cleanup_hold';
    const sessionId = 'agent_cleanup_hold';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const followUpMessageId = 'msg_018f1e2d3c4bCleanupHold001';

    const result = await runInDurableObject(stub, async instance => {
      const capturedPlans: FencedWrapperDispatchRequest[] = [];
      instance['orchestrator'] = {
        execute: async (plan: FencedWrapperDispatchRequest) => {
          capturedPlans.push(plan);
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_cleanup_hold' };
        },
      };
      instance['physicalWrapperStopper'] = async () => ({ status: 'absent' as const });
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_cleanup_hold',
        kiloSessionId: '22222222-2222-4222-8222-222222222222',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-cleanup-hold',
      });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'stop_needed',
        nextInstanceGeneration: 2,
        target: { kind: 'session' },
        reason: 'terminal-failed',
        requestedAt: 1,
        nextAttemptAt: Date.now() + 60_000,
        attempts: 0,
      });
      await storePendingSessionMessage(
        instance.ctx.storage,
        createPendingSessionMessage({
          messageId: followUpMessageId,
          role: 'user',
          content: 'follow after cleanup',
          createdAt: 1,
        })
      );

      await instance.alarm();
      const held = await listPendingSessionMessages(instance.ctx.storage);
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'stop_needed',
        nextInstanceGeneration: 2,
        target: { kind: 'session' },
        reason: 'terminal-failed',
        requestedAt: 1,
        nextAttemptAt: 1,
        attempts: 0,
      });
      await instance.alarm();
      await instance.alarm();

      return {
        held,
        remaining: await listPendingSessionMessages(instance.ctx.storage),
        capturedPlans,
      };
    });

    expect(result.held).toHaveLength(1);
    expect(result.held[0]?.flushAttempts).toBeUndefined();
    expect(result.remaining).toHaveLength(0);
    expect(result.capturedPlans.map(plan => plan.turn.messageId)).toContain(followUpMessageId);
  });
});
