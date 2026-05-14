/* eslint-disable drizzle/enforce-delete-with-where */
import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  findUnresolvedTerminalRenewalFailure,
  kiloclaw_subscriptions,
  kiloclaw_terminal_renewal_failures,
  listUnresolvedTerminalRenewalFailures,
  markTerminalRenewalFailureResolved,
  markTerminalRenewalFailureWaived,
  recordTerminalRenewalFailure,
  supersedeTerminalRenewalFailuresForBoundary,
  type KiloClawSubscription,
} from '@kilocode/db';
import type { User } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';

async function insertTestPureCreditSubscription(
  userId: string,
  overrides: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {}
): Promise<KiloClawSubscription> {
  const [row] = await db
    .insert(kiloclaw_subscriptions)
    .values({
      user_id: userId,
      payment_source: 'credits',
      plan: 'commit',
      status: 'active',
      credit_renewal_at: '2026-06-01T00:00:00.000Z',
      ...overrides,
    })
    .returning();
  return row;
}

describe('kiloclaw terminal renewal failure repository', () => {
  let user: User;
  let subscription: KiloClawSubscription;

  beforeEach(async () => {
    await cleanupDbForTest();
    user = await insertTestUser({
      google_user_email: `terminal-failure-${Date.now()}-${Math.random()}@example.com`,
    });
    subscription = await insertTestPureCreditSubscription(user.id);
  });

  describe('recordTerminalRenewalFailure', () => {
    it('inserts a new unresolved terminal failure row with first/last failure timestamps, attempt count, error code/message', async () => {
      const boundary = '2026-06-01T00:00:00.000Z';
      const observedAt = '2026-06-01T00:30:00.000Z';

      const recorded = await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        failureMessage: 'connection reset during atomic deduction',
        observedAt,
      });

      expect(recorded.status).toBe('unresolved');
      expect(recorded.subscription_id).toBe(subscription.id);
      expect(new Date(recorded.renewal_boundary).toISOString()).toBe(boundary);
      expect(recorded.attempt_count).toBe(3);
      expect(new Date(recorded.first_failure_at).toISOString()).toBe(observedAt);
      expect(new Date(recorded.last_failure_at).toISOString()).toBe(observedAt);
      expect(recorded.last_failure_code).toBe('renewal_transaction_failed');
      expect(recorded.last_failure_message).toBe('connection reset during atomic deduction');
      expect(recorded.resolution_actor_type).toBeNull();
      expect(recorded.resolution_actor_id).toBeNull();
      expect(recorded.resolution_at).toBeNull();
      expect(recorded.resolution_reason).toBeNull();

      const rows = await db
        .select()
        .from(kiloclaw_terminal_renewal_failures)
        .where(eq(kiloclaw_terminal_renewal_failures.subscription_id, subscription.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(recorded.id);
    });

    it('upserts on (subscription_id, renewal_boundary): preserves first_failure_at, advances last_failure_at, bumps attempt_count to GREATEST(stored, supplied)', async () => {
      const boundary = '2026-06-01T00:00:00.000Z';
      const firstObservedAt = '2026-06-01T00:30:00.000Z';
      const secondObservedAt = '2026-06-01T01:15:00.000Z';

      const initial = await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        failureMessage: 'first error',
        observedAt: firstObservedAt,
      });

      const duplicate = await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 5,
        failureCode: 'queue_delivery_exhausted',
        failureMessage: 'second error',
        observedAt: secondObservedAt,
      });

      expect(duplicate.id).toBe(initial.id);
      expect(duplicate.attempt_count).toBe(5);
      expect(new Date(duplicate.first_failure_at).toISOString()).toBe(firstObservedAt);
      expect(new Date(duplicate.last_failure_at).toISOString()).toBe(secondObservedAt);
      expect(duplicate.last_failure_code).toBe('queue_delivery_exhausted');
      expect(duplicate.last_failure_message).toBe('second error');

      const allRows = await db
        .select()
        .from(kiloclaw_terminal_renewal_failures)
        .where(eq(kiloclaw_terminal_renewal_failures.subscription_id, subscription.id));
      expect(allRows).toHaveLength(1);
    });

    it('does not regress attempt_count or last_failure_at when a duplicate arrives with lower values', async () => {
      const boundary = '2026-06-01T00:00:00.000Z';
      const laterObservedAt = '2026-06-01T02:00:00.000Z';
      const earlierObservedAt = '2026-06-01T00:30:00.000Z';

      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 7,
        failureCode: 'renewal_transaction_failed',
        failureMessage: 'later error',
        observedAt: laterObservedAt,
      });

      const second = await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 2,
        failureCode: 'worker_timeout',
        failureMessage: 'late-delivered earlier observation',
        observedAt: earlierObservedAt,
      });

      expect(second.attempt_count).toBe(7);
      expect(new Date(second.last_failure_at).toISOString()).toBe(laterObservedAt);
      expect(new Date(second.first_failure_at).toISOString()).toBe(laterObservedAt);
    });

    it('does not mutate resolved rows when a late duplicate terminal-failure message arrives', async () => {
      const boundary = '2026-06-01T00:00:00.000Z';
      const observedAt = '2026-06-01T00:30:00.000Z';
      const resolvedAt = '2026-06-01T01:00:00.000Z';

      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        failureMessage: 'original error',
        observedAt,
      });
      await markTerminalRenewalFailureResolved(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        actor: { type: 'operator', id: 'ops-user-1' },
        reason: 'operator retry succeeded',
        resolvedAt,
      });

      const lateDuplicate = await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 9,
        failureCode: 'queue_delivery_exhausted',
        failureMessage: 'late duplicate after resolution',
        observedAt: '2026-06-01T02:00:00.000Z',
      });

      expect(lateDuplicate.status).toBe('resolved');
      expect(lateDuplicate.attempt_count).toBe(3);
      expect(new Date(lateDuplicate.last_failure_at).toISOString()).toBe(observedAt);
      expect(lateDuplicate.last_failure_code).toBe('renewal_transaction_failed');
      expect(lateDuplicate.last_failure_message).toBe('original error');
      expect(lateDuplicate.resolution_reason).toBe('operator retry succeeded');
    });
  });

  describe('findUnresolvedTerminalRenewalFailure', () => {
    it('returns the unresolved row for a (subscription_id, renewal_boundary) protected from enforcement', async () => {
      const boundary = '2026-06-01T00:00:00.000Z';
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        failureMessage: null,
        observedAt: '2026-06-01T00:30:00.000Z',
      });

      const found = await findUnresolvedTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
      });

      expect(found).not.toBeNull();
      expect(found?.subscription_id).toBe(subscription.id);
      expect(found?.status).toBe('unresolved');
    });

    it('returns null when no row exists for the supplied key', async () => {
      const found = await findUnresolvedTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-06-01T00:00:00.000Z',
      });
      expect(found).toBeNull();
    });

    it('returns null when a different boundary on the same subscription has an unresolved failure', async () => {
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-06-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-06-01T00:30:00.000Z',
      });

      const found = await findUnresolvedTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-07-01T00:00:00.000Z',
      });
      expect(found).toBeNull();
    });
  });

  describe('markTerminalRenewalFailureResolved', () => {
    const boundary = '2026-06-01T00:00:00.000Z';
    const resolvedAt = '2026-06-02T10:00:00.000Z';
    const actor = { type: 'operator', id: 'ops-user-1' } as const;

    it('transitions an unresolved failure to resolved with operator metadata and removes enforcement protection', async () => {
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-06-01T00:30:00.000Z',
      });

      const resolved = await markTerminalRenewalFailureResolved(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        actor,
        reason: 'retry succeeded after queue recovery',
        resolvedAt,
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.status).toBe('resolved');
      expect(resolved?.resolution_actor_type).toBe('operator');
      expect(resolved?.resolution_actor_id).toBe('ops-user-1');
      expect(resolved?.resolution_reason).toBe('retry succeeded after queue recovery');
      expect(new Date(resolved?.resolution_at ?? '').toISOString()).toBe(resolvedAt);

      const stillUnresolved = await findUnresolvedTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
      });
      expect(stillUnresolved).toBeNull();
    });

    it('returns null and writes nothing when no unresolved row matches the key', async () => {
      const result = await markTerminalRenewalFailureResolved(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        actor,
        reason: 'speculative resolution',
        resolvedAt,
      });
      expect(result).toBeNull();

      const rows = await db.select().from(kiloclaw_terminal_renewal_failures);
      expect(rows).toHaveLength(0);
    });

    it('does not re-transition an already-resolved row to resolved (idempotent on subsequent attempts)', async () => {
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-06-01T00:30:00.000Z',
      });

      const first = await markTerminalRenewalFailureResolved(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        actor,
        reason: 'first resolution',
        resolvedAt,
      });
      expect(first?.status).toBe('resolved');

      const second = await markTerminalRenewalFailureResolved(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        actor: { type: 'operator', id: 'ops-user-2' },
        reason: 'second attempt should not overwrite first resolution',
        resolvedAt: '2026-06-03T10:00:00.000Z',
      });
      expect(second).toBeNull();

      const [persisted] = await db
        .select()
        .from(kiloclaw_terminal_renewal_failures)
        .where(eq(kiloclaw_terminal_renewal_failures.subscription_id, subscription.id));
      expect(persisted.resolution_actor_id).toBe('ops-user-1');
      expect(persisted.resolution_reason).toBe('first resolution');
    });
  });

  describe('markTerminalRenewalFailureWaived', () => {
    const boundary = '2026-06-01T00:00:00.000Z';
    const waivedAt = '2026-06-02T11:00:00.000Z';
    const actor = { type: 'operator', id: 'ops-user-1' } as const;

    it('transitions an unresolved failure to waived with operator metadata and removes enforcement protection', async () => {
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-06-01T00:30:00.000Z',
      });

      const waived = await markTerminalRenewalFailureWaived(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        actor,
        reason: 'support compensation issued out-of-band',
        resolvedAt: waivedAt,
      });

      expect(waived).not.toBeNull();
      expect(waived?.status).toBe('waived');
      expect(waived?.resolution_actor_type).toBe('operator');
      expect(waived?.resolution_actor_id).toBe('ops-user-1');
      expect(waived?.resolution_reason).toBe('support compensation issued out-of-band');
      expect(new Date(waived?.resolution_at ?? '').toISOString()).toBe(waivedAt);

      const stillUnresolved = await findUnresolvedTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
      });
      expect(stillUnresolved).toBeNull();
    });

    it('refuses to waive a row already resolved (status remains resolved)', async () => {
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-06-01T00:30:00.000Z',
      });
      await markTerminalRenewalFailureResolved(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        actor,
        reason: 'manual retry succeeded',
        resolvedAt: '2026-06-02T10:00:00.000Z',
      });

      const waived = await markTerminalRenewalFailureWaived(db, {
        subscriptionId: subscription.id,
        renewalBoundary: boundary,
        actor,
        reason: 'late waiver request',
        resolvedAt: waivedAt,
      });
      expect(waived).toBeNull();

      const [persisted] = await db
        .select()
        .from(kiloclaw_terminal_renewal_failures)
        .where(eq(kiloclaw_terminal_renewal_failures.subscription_id, subscription.id));
      expect(persisted.status).toBe('resolved');
      expect(persisted.resolution_reason).toBe('manual retry succeeded');
    });
  });

  describe('supersedeTerminalRenewalFailuresForBoundary', () => {
    it('supersedes unresolved failures with strictly older boundaries when the subscription advances', async () => {
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-04-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-04-01T00:30:00.000Z',
      });
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-05-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'worker_timeout',
        observedAt: '2026-05-01T00:30:00.000Z',
      });
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-06-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'queue_delivery_exhausted',
        observedAt: '2026-06-01T00:30:00.000Z',
      });

      const transitioned = await supersedeTerminalRenewalFailuresForBoundary(db, {
        subscriptionId: subscription.id,
        currentBoundary: '2026-06-01T00:00:00.000Z',
        actor: { type: 'system', id: 'billing-lifecycle-job' },
        supersededAt: '2026-06-01T01:00:00.000Z',
      });

      expect(transitioned).toHaveLength(2);
      const boundaries = transitioned.map(row => new Date(row.renewal_boundary).toISOString());
      expect(boundaries.sort()).toEqual(['2026-04-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z']);
      for (const row of transitioned) {
        expect(row.status).toBe('superseded');
        expect(row.resolution_actor_type).toBe('system');
        expect(row.resolution_actor_id).toBe('billing-lifecycle-job');
        expect(row.resolution_reason).toBe('subscription_boundary_advanced');
      }

      const stillProtected = await findUnresolvedTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-06-01T00:00:00.000Z',
      });
      expect(stillProtected).not.toBeNull();
      expect(stillProtected?.status).toBe('unresolved');
    });

    it('does not touch resolved, waived, or already-superseded rows', async () => {
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-04-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-04-01T00:30:00.000Z',
      });
      await markTerminalRenewalFailureResolved(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-04-01T00:00:00.000Z',
        actor: { type: 'operator', id: 'ops-user-1' },
        reason: 'manual retry',
        resolvedAt: '2026-04-01T01:00:00.000Z',
      });
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-05-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'worker_timeout',
        observedAt: '2026-05-01T00:30:00.000Z',
      });
      await markTerminalRenewalFailureWaived(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-05-01T00:00:00.000Z',
        actor: { type: 'operator', id: 'ops-user-1' },
        reason: 'support waiver',
        resolvedAt: '2026-05-01T01:00:00.000Z',
      });

      const transitioned = await supersedeTerminalRenewalFailuresForBoundary(db, {
        subscriptionId: subscription.id,
        currentBoundary: '2026-06-01T00:00:00.000Z',
        actor: { type: 'system', id: 'billing-lifecycle-job' },
        supersededAt: '2026-06-01T01:00:00.000Z',
      });
      expect(transitioned).toHaveLength(0);

      const allRows = await db
        .select()
        .from(kiloclaw_terminal_renewal_failures)
        .where(eq(kiloclaw_terminal_renewal_failures.subscription_id, subscription.id));
      const statuses = allRows.map(r => r.status).sort();
      expect(statuses).toEqual(['resolved', 'waived']);
    });

    it('only supersedes failures for the named subscription, not other subscriptions of the same user', async () => {
      const otherSubscription = await insertTestPureCreditSubscription(user.id, {
        credit_renewal_at: '2026-06-01T00:00:00.000Z',
      });

      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-04-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-04-01T00:30:00.000Z',
      });
      await recordTerminalRenewalFailure(db, {
        subscriptionId: otherSubscription.id,
        renewalBoundary: '2026-04-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-04-01T00:30:00.000Z',
      });

      await supersedeTerminalRenewalFailuresForBoundary(db, {
        subscriptionId: subscription.id,
        currentBoundary: '2026-06-01T00:00:00.000Z',
        actor: { type: 'system', id: 'billing-lifecycle-job' },
        supersededAt: '2026-06-01T01:00:00.000Z',
      });

      const otherStillProtected = await findUnresolvedTerminalRenewalFailure(db, {
        subscriptionId: otherSubscription.id,
        renewalBoundary: '2026-04-01T00:00:00.000Z',
      });
      expect(otherStillProtected).not.toBeNull();
    });
  });

  describe('listUnresolvedTerminalRenewalFailures', () => {
    it('returns only unresolved failures across subscriptions, oldest first_failure_at first', async () => {
      const otherSubscription = await insertTestPureCreditSubscription(user.id);

      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-05-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'worker_timeout',
        observedAt: '2026-05-01T08:00:00.000Z',
      });
      await recordTerminalRenewalFailure(db, {
        subscriptionId: otherSubscription.id,
        renewalBoundary: '2026-04-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-04-01T08:00:00.000Z',
      });
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-06-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'queue_delivery_exhausted',
        observedAt: '2026-06-01T08:00:00.000Z',
      });
      await markTerminalRenewalFailureResolved(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-05-01T00:00:00.000Z',
        actor: { type: 'operator', id: 'ops-user-1' },
        reason: 'retry succeeded',
        resolvedAt: '2026-05-02T00:00:00.000Z',
      });

      const rows = await listUnresolvedTerminalRenewalFailures(db);
      expect(rows.map(r => new Date(r.first_failure_at).toISOString())).toEqual([
        '2026-04-01T08:00:00.000Z',
        '2026-06-01T08:00:00.000Z',
      ]);
      for (const row of rows) {
        expect(row.status).toBe('unresolved');
      }
    });

    it('filters by subscriptionId when supplied', async () => {
      const otherSubscription = await insertTestPureCreditSubscription(user.id);
      await recordTerminalRenewalFailure(db, {
        subscriptionId: subscription.id,
        renewalBoundary: '2026-05-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'worker_timeout',
        observedAt: '2026-05-01T08:00:00.000Z',
      });
      await recordTerminalRenewalFailure(db, {
        subscriptionId: otherSubscription.id,
        renewalBoundary: '2026-04-01T00:00:00.000Z',
        attempts: 3,
        failureCode: 'renewal_transaction_failed',
        observedAt: '2026-04-01T08:00:00.000Z',
      });

      const rows = await listUnresolvedTerminalRenewalFailures(db, {
        subscriptionId: subscription.id,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].subscription_id).toBe(subscription.id);
    });

    it('caps the result count when limit is supplied', async () => {
      for (const boundary of [
        '2026-04-01T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
      ]) {
        await recordTerminalRenewalFailure(db, {
          subscriptionId: subscription.id,
          renewalBoundary: boundary,
          attempts: 3,
          failureCode: 'renewal_transaction_failed',
          observedAt: boundary,
        });
      }

      const rows = await listUnresolvedTerminalRenewalFailures(db, { limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map(r => new Date(r.renewal_boundary).toISOString())).toEqual([
        '2026-04-01T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z',
      ]);
    });
  });
});
