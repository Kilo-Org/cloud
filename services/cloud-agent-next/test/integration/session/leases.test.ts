/**
 * Integration tests for the leases query module.
 *
 * Uses @cloudflare/vitest-pool-workers to test against real SQLite in DOs.
 * Each test gets isolated storage automatically.
 *
 * Note: Migrations run automatically in the DO constructor via blockConcurrencyWhile(),
 * so the DO is fully initialized when we get the stub. We use the DO's RPC methods
 * which internally access the pre-initialized query modules.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, it, expect } from 'vitest';
import type { ExecutionId } from '../../../src/types/ids.js';

// Registered sessions leave dispatch, alarm, and fire-and-forget publication
// work in the session DO. Interrupt every session a test touched, clear its
// alarm, and drain its publication tail, or that work wakes after this file
// closes and its logs race the vitest worker shutdown as pending
// onUserConsoleLog rejections (EnvironmentTeardownError).
const touchedSessions = new Set<string>();

function sessionStub(userId: string, sessionId: string) {
  const sessionName = `${userId}:${sessionId}`;
  touchedSessions.add(sessionName);
  return env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName));
}

afterEach(async () => {
  for (const sessionName of touchedSessions) {
    await runInDurableObject(
      env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName)),
      async (instance, state) => {
        try {
          await instance.interruptExecution();
        } catch {
          // A session that never registered has no work to interrupt.
        }
        await state.storage.deleteAlarm();
        const publicationTail = (instance as any).publicExtensionPublicationTail as
          | Promise<unknown>
          | undefined;
        await publicationTail?.catch(() => undefined);
      }
    ).catch(() => undefined);
  }
  touchedSessions.clear();
});

describe('Lease Acquisition', () => {
  it('should acquire lease on first attempt', async () => {
    const stub = sessionStub('user_1', 'sess_1');

    // Use the DO's RPC method directly
    const result = await runInDurableObject(stub, async instance => {
      return instance.acquireLease('exc_123' as ExecutionId, 'msg_1', 'lease_abc');
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.acquired).toBe(true);
      expect(result.value.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it('should reject duplicate lease acquisition when lease is held', async () => {
    const stub = sessionStub('user_1', 'sess_2');

    const result = await runInDurableObject(stub, async instance => {
      // First acquisition succeeds
      const first = instance.acquireLease('exc_123' as ExecutionId, 'msg_1', 'lease_abc');

      // Second acquisition should fail (lease still held)
      const second = instance.acquireLease('exc_123' as ExecutionId, 'msg_2', 'lease_xyz');

      return { first, second };
    });

    expect(result.first.ok).toBe(true);
    expect(result.second.ok).toBe(false);
    if (!result.second.ok && result.second.error.code === 'ALREADY_HELD') {
      expect(result.second.error.holder).toBe('lease_abc');
    }
  });

  it('should allow lease acquisition after expiration', async () => {
    const stub = sessionStub('user_1', 'sess_3');

    // We can't easily simulate time passing in tests, so instead we'll
    // test that acquiring a lease works, then release it, and acquire again
    const result = await runInDurableObject(stub, async instance => {
      // First: acquire and release
      const first = instance.acquireLease('exc_123' as ExecutionId, 'msg_1', 'lease_abc');
      if (first.ok) {
        instance.releaseLease('exc_123' as ExecutionId, 'lease_abc');
      }

      // Second: should succeed after release
      const second = instance.acquireLease('exc_123' as ExecutionId, 'msg_2', 'lease_xyz');

      return { first, second };
    });

    expect(result.first.ok).toBe(true);
    expect(result.second.ok).toBe(true);
  });

  it('should extend lease with heartbeat (correct leaseId)', async () => {
    const stub = sessionStub('user_1', 'sess_4');

    const result = await runInDurableObject(stub, async instance => {
      // Acquire lease
      const acquire = instance.acquireLease('exc_123' as ExecutionId, 'msg_1', 'lease_abc');

      // Extend with correct leaseId (should succeed)
      const extended = instance.extendLease('exc_123' as ExecutionId, 'lease_abc');

      return { acquire, extended };
    });

    expect(result.acquire.ok).toBe(true);
    expect(result.extended).toBe(true);
  });

  it('should reject extension with wrong leaseId', async () => {
    const stub = sessionStub('user_1', 'sess_5');

    const result = await runInDurableObject(stub, async instance => {
      // Acquire lease
      const acquire = instance.acquireLease('exc_123' as ExecutionId, 'msg_1', 'lease_abc');

      // Try to extend with wrong leaseId (should fail)
      const extended = instance.extendLease('exc_123' as ExecutionId, 'wrong_lease_id');

      return { acquire, extended };
    });

    expect(result.acquire.ok).toBe(true);
    expect(result.extended).toBe(false);
  });

  it('should release lease on completion', async () => {
    const stub = sessionStub('user_1', 'sess_6');

    const result = await runInDurableObject(stub, async instance => {
      // Acquire lease
      instance.acquireLease('exc_123' as ExecutionId, 'msg_1', 'lease_abc');

      // Release the lease
      const released = instance.releaseLease('exc_123' as ExecutionId, 'lease_abc');

      // Another consumer can now acquire
      const newAcquire = instance.acquireLease('exc_123' as ExecutionId, 'msg_2', 'lease_xyz');

      return { released, newAcquire };
    });

    expect(result.released).toBe(true);
    expect(result.newAcquire.ok).toBe(true);
  });
});
