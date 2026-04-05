/**
 * Integration tests for DO queue dispatcher state transitions.
 *
 * Tests that the dispatcher properly handles state transitions and
 * validates that executions must go through 'running' before completion.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ExecutionMessage } from '../../../src/queue/types.js';
import type { ExecutionId } from '../../../src/types/ids.js';

describe('DO Queue Dispatcher State Transitions', () => {
  it('should properly transition pending → running → completed', async () => {
    const userId = 'user_state_test';
    const sessionId = 'agent_state_test';

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      // Prepare session
      await instance.prepare({
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '44444444-4444-4444-8444-444444444444',
        prompt: 'test',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'test-token',
      });

      // Create execution message
      const exec: ExecutionMessage = {
        executionId: 'exec_state_test' as ExecutionId,
        sessionId,
        userId,
        orgId: 'org_test',
        sandboxId: 'sandbox_test',
        mode: 'code',
        prompt: 'test command',
      };

      // Enqueue - should start immediately
      await instance.enqueueExecution(exec, true);

      // Get execution - should be pending
      const execAfterEnqueue = await instance.getExecution('exec_state_test' as ExecutionId);

      // Transition to running (simulating what the runner does)
      const runningResult = await instance.updateExecutionStatus({
        executionId: 'exec_state_test' as ExecutionId,
        status: 'running',
      });

      // Get execution - should be running
      const execAfterRunning = await instance.getExecution('exec_state_test' as ExecutionId);

      // Complete the execution
      await instance.onExecutionComplete('exec_state_test' as ExecutionId, 'completed');

      // Get execution - should be completed
      const execAfterComplete = await instance.getExecution('exec_state_test' as ExecutionId);

      return {
        execAfterEnqueue,
        runningResult,
        execAfterRunning,
        execAfterComplete,
      };
    });

    // Verify state transitions
    expect(result.execAfterEnqueue?.status).toBe('pending');
    expect(result.runningResult.ok).toBe(true);
    expect(result.execAfterRunning?.status).toBe('running');
    expect(result.execAfterComplete?.status).toBe('completed');
  });

  it('should reject invalid transition pending → completed', async () => {
    const userId = 'user_invalid_transition';
    const sessionId = 'agent_invalid_transition';

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await instance.prepare({
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '55555555-5555-4555-8555-555555555555',
        prompt: 'test',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'test-token',
      });

      const exec: ExecutionMessage = {
        executionId: 'exec_invalid' as ExecutionId,
        sessionId,
        userId,
        orgId: 'org_test',
        sandboxId: 'sandbox_test',
        mode: 'code',
        prompt: 'test command',
      };

      // Enqueue
      await instance.enqueueExecution(exec, true);

      // Try to complete without transitioning to running first
      // This should be rejected by updateStatus inside onExecutionComplete
      await instance.onExecutionComplete('exec_invalid' as ExecutionId, 'completed');

      // Get final state
      const finalExec = await instance.getExecution('exec_invalid' as ExecutionId);

      return { finalExec };
    });

    // Should still be pending (transition was rejected)
    expect(result.finalExec?.status).toBe('pending');
  });

  it('should handle updateExecutionStatus failure gracefully', async () => {
    const userId = 'user_update_failure';
    const sessionId = 'agent_update_failure';

    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await instance.prepare({
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '66666666-6666-4666-8666-666666666666',
        prompt: 'test',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'test-token',
      });

      const exec: ExecutionMessage = {
        executionId: 'exec_update_test' as ExecutionId,
        sessionId,
        userId,
        orgId: 'org_test',
        sandboxId: 'sandbox_test',
        mode: 'code',
        prompt: 'test command',
      };

      await instance.enqueueExecution(exec, true);

      // Try an invalid transition
      const invalidResult = await instance.updateExecutionStatus({
        executionId: 'exec_update_test' as ExecutionId,
        status: 'completed', // Invalid: pending → completed
      });

      // Try a valid transition
      const validResult = await instance.updateExecutionStatus({
        executionId: 'exec_update_test' as ExecutionId,
        status: 'running', // Valid: pending → running
      });

      const finalExec = await instance.getExecution('exec_update_test' as ExecutionId);

      return { invalidResult, validResult, finalExec };
    });

    // Invalid transition should fail
    expect(result.invalidResult.ok).toBe(false);
    if (!result.invalidResult.ok) {
      expect(result.invalidResult.error.code).toBe('INVALID_TRANSITION');
    }

    // Valid transition should succeed
    expect(result.validResult.ok).toBe(true);
    expect(result.finalExec?.status).toBe('running');
  });
});
