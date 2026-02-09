/**
 * Integration tests for DO-orchestrated V2 execution start.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ExecutionId } from '../../../src/types/ids.js';
import type { StartExecutionV2Request } from '../../../src/queue/types.js';

describe('CloudAgentSession.startExecutionV2', () => {
  it('returns EXECUTION_IN_PROGRESS when an active execution exists', async () => {
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

      const activeId = 'exc_active' as ExecutionId;
      await instance.addExecution({
        executionId: activeId,
        mode: 'build',
        streamingMode: 'websocket',
        ingestToken: activeId,
      });
      await instance.setActiveExecution(activeId);

      const request: StartExecutionV2Request = {
        kind: 'initiate',
        userId,
        authToken: 'token-init',
        prompt: 'do the thing',
        mode: 'build',
        model: 'test-model',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      };

      const startResult = await instance.startExecutionV2(request);
      return { startResult, plan: capturedPlan };
    });

    expect(result.startResult.success).toBe(false);
    if (result.startResult.success) return;

    expect(result.startResult.code).toBe('EXECUTION_IN_PROGRESS');
    expect(result.startResult.activeExecutionId).toBe('exc_active');
    expect(result.plan).toBeNull();
  });

  it('builds a launch plan for follow-up and applies token overrides', async () => {
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

      await instance.prepare({
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '88888888-8888-4888-8888-888888888888',
        prompt: 'prepared prompt',
        mode: 'build',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      await instance.tryInitiate();

      const request: StartExecutionV2Request = {
        kind: 'followup',
        userId,
        prompt: 'followup prompt',
        tokenOverrides: {
          gitToken: 'new-token',
        },
      };

      const startResult = await instance.startExecutionV2(request);
      const metadata = await instance.getMetadata();
      return { startResult, metadata, plan: capturedPlan };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.status).toBe('started');
    expect(result.metadata?.gitToken).toBe('new-token');
    expect(result.plan).toBeTruthy();
    expect(result.plan.workspace.shouldPrepare).toBe(false);
    expect(result.plan.workspace.resumeContext.kilocodeToken).toBe('token-followup');
    expect(result.plan.workspace.resumeContext.gitToken).toBe('new-token');
  });
});
