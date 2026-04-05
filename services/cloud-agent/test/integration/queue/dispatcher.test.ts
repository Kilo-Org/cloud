/**
 * Integration tests for DO queue dispatcher (enqueueExecution + tryAdvanceQueue + onExecutionComplete).
 *
 * Tests FIFO ordering, max queue depth (3), and 1-hour expiry behavior using real DO storage.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ExecutionMessage } from '../../../src/queue/types.js';
import type { ExecutionId } from '../../../src/types/ids.js';

describe('DO Queue Dispatcher', () => {
  it('should enforce FIFO ordering: first enqueue starts, second queues, completion advances', async () => {
    const userId = 'user_fifo_test';
    const sessionId = 'agent_fifo_test';

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      // Prepare session inside DO context
      const prepareResult = await instance.prepare({
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '11111111-1111-4111-8111-111111111111',
        prompt: 'test prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'test-token',
      });

      if (!prepareResult.success) {
        throw new Error(`Prepare failed: ${prepareResult.error}`);
      }

      // Check if session was actually prepared
      const metadata = await instance.getMetadata();
      if (!metadata?.preparedAt) {
        throw new Error('Session metadata missing preparedAt after prepare()');
      }

      // Create two execution messages
      const exec1: ExecutionMessage = {
        executionId: 'exec_1' as ExecutionId,
        sessionId,
        userId,
        orgId: 'org_test',
        sandboxId: 'sandbox_test',
        mode: 'code',
        prompt: 'first command',
      };

      const exec2: ExecutionMessage = {
        executionId: 'exec_2' as ExecutionId,
        sessionId,
        userId,
        orgId: 'org_test',
        sandboxId: 'sandbox_test',
        mode: 'code',
        prompt: 'second command',
      };

      // Enqueue first - should start immediately
      const enqueue1 = await instance.enqueueExecution(exec1, true);

      // Check active execution
      const active1 = await instance.getActiveExecutionId();

      // Get queue count
      const queueCount1 = instance.getQueuedCount();

      // Enqueue second - should be queued
      const enqueue2 = await instance.enqueueExecution(exec2, false);

      const queueCount2 = instance.getQueuedCount();

      // Transition first execution to running (simulating what runner does)
      await instance.updateExecutionStatus({
        executionId: 'exec_1' as ExecutionId,
        status: 'running',
      });

      // Complete first execution
      await instance.onExecutionComplete('exec_1' as ExecutionId, 'completed');

      // Check that second execution became active
      const active2 = await instance.getActiveExecutionId();

      const queueCount3 = instance.getQueuedCount();

      return {
        enqueue1,
        active1,
        queueCount1,
        enqueue2,
        queueCount2,
        active2,
        queueCount3,
      };
    });

    // First enqueue should start immediately
    expect(result.enqueue1.status).toBe('started');
    expect(result.active1).toBe('exec_1');
    expect(result.queueCount1).toBe(0);

    // Second enqueue should be queued
    expect(result.enqueue2.status).toBe('queued');
    expect(result.queueCount2).toBe(1);

    // After completion, second should become active
    expect(result.active2).toBe('exec_2');
    expect(result.queueCount3).toBe(0);
  });

  it('should enforce max queue depth of 3', async () => {
    const userId = 'user_max_depth';
    const sessionId = 'agent_max_depth';

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      // Prepare session inside DO context
      await instance.prepare({
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '22222222-2222-4222-8222-222222222222',
        prompt: 'test',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'test-token',
      });
      // Create 5 messages
      const messages: ExecutionMessage[] = Array.from({ length: 5 }, (_, i) => ({
        executionId: `exec_${i}` as ExecutionId,
        sessionId,
        userId,
        orgId: 'org_test',
        sandboxId: 'sandbox_test',
        mode: 'code',
        prompt: `command ${i}`,
      }));

      // Enqueue all 5
      const results = [];
      for (let i = 0; i < 5; i++) {
        try {
          const result = await instance.enqueueExecution(messages[i], i === 0);
          results.push({ success: true, status: result.status });
        } catch (error) {
          results.push({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const queueCount = instance.getQueuedCount();

      return { results, queueCount };
    });

    // First should start
    expect(result.results[0]).toEqual({ success: true, status: 'started' });

    // Next 3 should queue
    expect(result.results[1]).toEqual({ success: true, status: 'queued' });
    expect(result.results[2]).toEqual({ success: true, status: 'queued' });
    expect(result.results[3]).toEqual({ success: true, status: 'queued' });

    // 5th should be rejected (queue full)
    expect(result.results[4].success).toBe(false);
    expect((result.results[4] as { error: string }).error).toContain('Queue is full');

    // Queue count should be 3 (max depth)
    expect(result.queueCount).toBe(3);
  });

  it('should skip expired commands and mark them as failed', async () => {
    const userId = 'user_expiry';
    const sessionId = 'agent_expiry';

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      // Prepare session inside DO context
      await instance.prepare({
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '33333333-3333-4333-8333-333333333333',
        prompt: 'test',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'test-token',
      });
      // We need to directly manipulate the queue to insert an expired entry
      // Use the command queue queries directly
      const commandQueueQueries = (instance as any).commandQueueQueries;
      const executionQueries = (instance as any).executionQueries;

      // Create an execution record first
      await executionQueries.add({
        executionId: 'exec_expired' as ExecutionId,
        mode: 'code',
        streamingMode: 'websocket',
      });

      // Create expired message (created 2 hours ago)
      const expiredMessage: ExecutionMessage = {
        executionId: 'exec_expired' as ExecutionId,
        sessionId,
        userId,
        orgId: 'org_test',
        sandboxId: 'sandbox_test',
        mode: 'code',
        prompt: 'expired command',
      };

      // Manually insert into queue with old timestamp
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const sql = (instance as any).ctx.storage.sql;
      sql.exec(
        `INSERT INTO command_queue (session_id, execution_id, message_json, created_at) VALUES (?, ?, ?, ?)`,
        sessionId,
        'exec_expired',
        JSON.stringify(expiredMessage),
        twoHoursAgo
      );

      // Create a fresh message
      const freshMessage: ExecutionMessage = {
        executionId: 'exec_fresh' as ExecutionId,
        sessionId,
        userId,
        orgId: 'org_test',
        sandboxId: 'sandbox_test',
        mode: 'code',
        prompt: 'fresh command',
      };

      // Enqueue fresh message (should purge expired and start fresh)
      const enqueueResult = await instance.enqueueExecution(freshMessage, true);

      // Check what became active
      const activeExec = await instance.getActiveExecutionId();

      // Check status of expired execution
      const expiredExec = await instance.getExecution('exec_expired' as ExecutionId);

      return {
        enqueueResult,
        activeExec,
        expiredExec,
      };
    });

    // Fresh command should start
    expect(result.enqueueResult.status).toBe('started');
    expect(result.activeExec).toBe('exec_fresh');

    // Expired execution should be marked as failed
    expect(result.expiredExec?.status).toBe('failed');
    expect(result.expiredExec?.error).toBe('queue_expired');
  });
});
