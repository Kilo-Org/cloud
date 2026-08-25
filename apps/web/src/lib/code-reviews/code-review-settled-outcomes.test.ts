/**
 * @jest-environment node
 *
 * Code Review settled-outcome coverage (P1-A-07c). Runs against the migrated
 * test database: `admitOperation` admits a `code_review` row and
 * `settleCodeReviewLedgerRow` settles it through the real ledger helpers, so
 * the assertions cover the actual outbox row and the deterministic
 * settle-plus-outbox atomicity.
 */
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { analytics_event_outbox, kilocode_users, operation_ledgers } from '@kilocode/db/schema';
import { admitOperation } from '@kilocode/db/operation-ledger';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  codeReviewLedgerIntent,
  codeReviewTerminalOutcome,
  settleCodeReviewLedgerRow,
} from './code-review-ledger';

async function admitReview(reviewId: string, intent: 'manual' | 'webhook' = 'manual') {
  return admitOperation(db, {
    userId: 'review-owner',
    domain: 'code_review',
    intent,
    operationKey: `review:${reviewId}`,
    taxonomy: 'never-replay',
    leaseSeconds: 60,
  });
}

describe('code review settled outcomes', () => {
  beforeEach(async () => {
    await db.delete(analytics_event_outbox).where(sql`true`);
    await db.delete(operation_ledgers).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(analytics_event_outbox).where(sql`true`);
    await db.delete(operation_ledgers).where(sql`true`);
  });

  describe('codeReviewLedgerIntent', () => {
    it('maps webhook to webhook and everything else, including null legacy rows, to manual', () => {
      expect(codeReviewLedgerIntent('webhook')).toBe('webhook');
      expect(codeReviewLedgerIntent('manual')).toBe('manual');
      expect(codeReviewLedgerIntent(null)).toBe('manual');
    });
  });

  describe('codeReviewTerminalOutcome', () => {
    it('maps terminal review states to ledger outcomes', () => {
      expect(codeReviewTerminalOutcome('completed', null)).toBe('completed');
      expect(codeReviewTerminalOutcome('failed', 'timeout')).toBe('failed');
      expect(codeReviewTerminalOutcome('cancelled', 'superseded')).toBe('superseded');
      expect(codeReviewTerminalOutcome('cancelled', 'interrupted')).toBe('interrupted');
      expect(codeReviewTerminalOutcome('cancelled', 'model_not_found')).toBe('no_op');
      expect(codeReviewTerminalOutcome('cancelled', 'user_cancelled')).toBe('no_op');
    });

    it('returns null for non-terminal states', () => {
      expect(codeReviewTerminalOutcome('pending', null)).toBeNull();
      expect(codeReviewTerminalOutcome('queued', null)).toBeNull();
      expect(codeReviewTerminalOutcome('running', null)).toBeNull();
    });
  });

  describe('settleCodeReviewLedgerRow', () => {
    it('resolves the user email for distinctId, matching the sibling emitters', async () => {
      const user = await insertTestUser();
      const reviewId = randomUUID();
      await admitOperation(db, {
        userId: user.id,
        domain: 'code_review',
        intent: 'manual',
        operationKey: `review:${reviewId}`,
        taxonomy: 'never-replay',
        leaseSeconds: 60,
      });

      await settleCodeReviewLedgerRow({
        reviewId,
        status: 'completed',
        terminalReason: null,
        triggerSource: 'manual',
      });

      const rows = await db.select().from(analytics_event_outbox);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.distinct_id).toBe(user.google_user_email);

      await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
    });

    it('falls back to the raw user id when no user row exists', async () => {
      const reviewId = randomUUID();
      await admitOperation(db, {
        userId: 'missing-user',
        domain: 'code_review',
        intent: 'manual',
        operationKey: `review:${reviewId}`,
        taxonomy: 'never-replay',
        leaseSeconds: 60,
      });

      await settleCodeReviewLedgerRow({
        reviewId,
        status: 'completed',
        terminalReason: null,
        triggerSource: 'manual',
      });

      const rows = await db.select().from(analytics_event_outbox);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.distinct_id).toBe('missing-user');
    });

    it('emits exactly one code_review_settled outbox row with only the contract keys', async () => {
      const reviewId = randomUUID();
      await admitReview(reviewId, 'webhook');

      await settleCodeReviewLedgerRow({
        reviewId,
        status: 'completed',
        terminalReason: null,
        triggerSource: 'webhook',
      });

      const rows = await db.select().from(analytics_event_outbox);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_name).toBe('code_review_settled');
      expect(rows[0]?.distinct_id).toBe('review-owner');
      expect(Object.keys(rows[0]?.properties ?? {}).sort()).toEqual([
        'duration_ms',
        'intent',
        'outcome',
        'phase',
        'source',
        'surface',
      ]);
      expect(rows[0]?.properties).toMatchObject({
        source: 'web',
        surface: 'code_review',
        phase: 'terminal',
        intent: 'webhook',
        outcome: 'completed',
      });
    });

    it('emits once per settle site and is double-run safe', async () => {
      // Site (a): analytics completion.
      const completedId = randomUUID();
      await admitReview(completedId, 'manual');
      await settleCodeReviewLedgerRow({
        reviewId: completedId,
        status: 'completed',
        terminalReason: null,
        triggerSource: 'manual',
      });

      // Site (b): model-not-found cancellation maps to no_op.
      const cancelledId = randomUUID();
      await admitReview(cancelledId, 'webhook');
      await settleCodeReviewLedgerRow({
        reviewId: cancelledId,
        status: 'cancelled',
        terminalReason: 'model_not_found',
        triggerSource: 'webhook',
      });

      // Site (c): reaper failure maps to failed.
      const failedId = randomUUID();
      await admitReview(failedId, 'manual');
      await settleCodeReviewLedgerRow({
        reviewId: failedId,
        status: 'failed',
        terminalReason: 'abandoned',
        triggerSource: 'manual',
      });

      // Double-run safety: settling site (b) again must not emit a second row.
      await settleCodeReviewLedgerRow({
        reviewId: cancelledId,
        status: 'cancelled',
        terminalReason: 'model_not_found',
        triggerSource: 'webhook',
      });

      const rows = await db.select().from(analytics_event_outbox);
      expect(rows).toHaveLength(3);
      expect(rows.map(row => (row.properties as { outcome: string }).outcome).sort()).toEqual([
        'completed',
        'failed',
        'no_op',
      ]);
    });

    it('maps interrupted→cancelled to the interrupted outcome and emits one terminal event', async () => {
      const reviewId = randomUUID();
      await admitReview(reviewId, 'manual');

      await settleCodeReviewLedgerRow({
        reviewId,
        status: 'cancelled',
        terminalReason: 'interrupted',
        triggerSource: 'manual',
      });

      const rows = await db.select().from(analytics_event_outbox);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.properties).toMatchObject({ outcome: 'interrupted', intent: 'manual' });
    });

    it('skips without throwing when no admit row exists', async () => {
      const reviewId = randomUUID();

      await expect(
        settleCodeReviewLedgerRow({
          reviewId,
          status: 'completed',
          terminalReason: null,
          triggerSource: 'manual',
        })
      ).resolves.toBeUndefined();

      expect(await db.select().from(analytics_event_outbox)).toHaveLength(0);
    });

    it('leaves the row admitted and emits nothing for a non-terminal review', async () => {
      const reviewId = randomUUID();
      await admitReview(reviewId, 'manual');

      await settleCodeReviewLedgerRow({
        reviewId,
        status: 'running',
        terminalReason: null,
        triggerSource: 'manual',
      });

      expect(await db.select().from(analytics_event_outbox)).toHaveLength(0);
      const [row] = await db
        .select()
        .from(operation_ledgers)
        .where(
          and(
            eq(operation_ledgers.domain, 'code_review'),
            eq(operation_ledgers.operation_key, `review:${reviewId}`)
          )
        );
      expect(row?.status).toBe('admitted');
    });
  });
});
