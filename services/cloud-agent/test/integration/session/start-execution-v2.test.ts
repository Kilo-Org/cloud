/**
 * Integration tests for DO-orchestrated V2 execution start.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ExecutionId } from '../../../src/types/ids.js';
import type { StartExecutionV2Request } from '../../../src/queue/types.js';

describe('CloudAgentSession.startExecutionV2', () => {
  it('builds a launch plan for initiate and queues when active exists', async () => {
    const userId = 'user_exec_plan' as const;
    const sessionId = 'agent_exec_plan' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      const now = Date.now();
      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      const activeId = 'exec_active' as ExecutionId;
      await instance.addExecution({
        executionId: activeId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: activeId,
      });
      await instance.setActiveExecution(activeId);

      const request: StartExecutionV2Request = {
        kind: 'initiate',
        userId,
        authToken: 'token-init',
        prompt: 'do the thing',
        mode: 'code',
        model: 'test-model',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'git-token',
      };

      const startResult = await instance.startExecutionV2(request);
      const queued = (instance as any).commandQueueQueries.peekOldest(sessionId);
      const message = queued ? JSON.parse(queued.message_json) : null;

      return { startResult, message };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.status).toBe('queued');
    expect(result.message?.launchPlan).toBeTruthy();
    expect(result.message.launchPlan.executionId).toBe(result.startResult.executionId);
    expect(result.message.launchPlan.promptFile).toContain(result.startResult.executionId);
    expect(result.message.launchPlan.workspace.shouldPrepare).toBe(true);
    expect(result.message.launchPlan.workspace.initContext.kilocodeToken).toBe('token-init');
    expect(result.message.launchPlan.wrapper.env.SESSION_ID).toBe(sessionId);
    expect(result.message.launchPlan.wrapper.env.USER_ID).toBe(userId);
    expect(result.message.launchPlan.wrapper.env.KILOCODE_TOKEN).toBe('token-init');
    expect(result.message.launchPlan.wrapper.args).toContain(
      `--execution-id=${result.startResult.executionId}`
    );
  });

  it('builds a launch plan for follow-up and applies token overrides', async () => {
    const userId = 'user_exec_followup' as const;
    const sessionId = 'agent_exec_followup' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await instance.prepare({
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

      await instance.tryInitiate();

      const activeId = 'exec_active_followup' as ExecutionId;
      await instance.addExecution({
        executionId: activeId,
        mode: 'code',
        streamingMode: 'websocket',
        ingestToken: activeId,
      });
      await instance.setActiveExecution(activeId);

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
      const queued = (instance as any).commandQueueQueries.peekOldest(sessionId);
      const message = queued ? JSON.parse(queued.message_json) : null;

      return { startResult, metadata, message };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.status).toBe('queued');
    expect(result.metadata?.gitToken).toBe('new-token');
    expect(result.message?.launchPlan).toBeTruthy();
    expect(result.message.launchPlan.workspace.shouldPrepare).toBe(false);
    expect(result.message.launchPlan.workspace.resumeContext.kilocodeToken).toBe('token-followup');
    expect(result.message.launchPlan.workspace.resumeContext.gitToken).toBe('new-token');
    expect(result.message.launchPlan.workspace.existingMetadata.gitToken).toBe('new-token');
    expect(result.message.launchPlan.wrapper.env.KILOCODE_TOKEN).toBe('token-followup');
  });
});
