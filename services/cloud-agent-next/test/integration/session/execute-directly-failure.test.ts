/**
 * Integration test for the executeDirectly catch-block fix in CloudAgentSession.
 *
 * When the orchestrator throws during executeDirectly, the execution must be
 * marked as failed (with a callback notification enqueued) and a synthetic
 * error stream event must be persisted — before the error propagates to the
 * startExecutionV2 outer catch which returns { success: false }.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';
import type { ExecutionId } from '../../../src/types/ids.js';
import type { StartExecutionV2Request } from '../../../src/execution/types.js';

describe('executeDirectly failure handling', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    expect(ids).toHaveLength(0);
  });

  it('orchestrator failure marks execution as failed with callback and stream event', async () => {
    const userId = 'user_exec_direct_fail';
    const sessionId = 'agent_exec_direct_fail';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      // Monkey-patch orchestrator to throw on execute
      (instance as any).orchestrator = {
        execute: async () => {
          throw new Error('Sandbox connect failed');
        },
      };

      const now = Date.now();

      // Prepare the session (required before followup)
      await instance.prepare({
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

      await instance.tryInitiate();

      // Send a followup — this triggers executeDirectly internally
      const request: StartExecutionV2Request = {
        kind: 'followup',
        userId,
        prompt: 'do some work',
      };

      const startResult = await instance.startExecutionV2(request);

      // The outer catch in startExecutionV2 converts the re-thrown error into
      // { success: false, code: 'INTERNAL', error: '...' }.
      // But before that, executeDirectly's catch block should have:
      // 1. Set execution status to 'failed'
      // 2. Cleared active execution
      // 3. Inserted a synthetic error stream event

      // Find the execution that was created during the call. startExecutionV2
      // creates a new executionId internally — query all executions to find it.
      const executions = await instance.getExecutions();
      const failedExec = executions.find((e: { status: string }) => e.status === 'failed');

      // Query events from the DO's SQLite
      const db = drizzle(state.storage, { logger: false });
      const eventQueries = createEventQueries(db, state.storage.sql);
      const allEvents = failedExec
        ? eventQueries.findByFilters({
            executionIds: [failedExec.executionId as ExecutionId],
          })
        : [];
      const errorEvents = allEvents.filter(e => e.stream_event_type === 'error');

      const activeExecId = await instance.getActiveExecutionId();

      return { startResult, failedExec, errorEvents, activeExecId };
    });

    // startExecutionV2 returns { success: false } because executeDirectly re-throws
    expect(result.startResult.success).toBe(false);
    if (!result.startResult.success) {
      expect(result.startResult.code).toBe('INTERNAL');
      expect(result.startResult.error).toContain('Sandbox connect failed');
    }

    // The execution was created and then marked as failed by the catch block
    expect(result.failedExec).toBeDefined();
    expect(result.failedExec!.status).toBe('failed');
    expect(result.failedExec!.error).toContain('Sandbox connect failed');

    // Active execution should have been cleared
    expect(result.activeExecId).toBeNull();

    // A synthetic error stream event should have been inserted
    expect(result.errorEvents).toHaveLength(1);
    const payload = JSON.parse(result.errorEvents[0].payload);
    expect(payload.fatal).toBe(true);
    expect(payload.error).toBe('Sandbox connect failed');
  });
});
