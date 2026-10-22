import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import { kiloclaw_subscriptions, operation_ledgers } from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';

import {
  createStripeRenewalBatchPreview,
  getStripeRenewalBatchStatus,
  purgeExpiredStripeRenewalBatches,
  retryStripeRenewalBatch,
  runStripeRenewalBatches,
  startStripeRenewalBatch,
} from './admin-stripe-renewal-batch';
import { stopKiloClawStripeRenewal } from './stop-stripe-renewal';

jest.mock('./stop-stripe-renewal', () => ({ stopKiloClawStripeRenewal: jest.fn() }));

const actor = { id: 'admin-renewal-batch', email: 'admin@example.com', name: 'Admin' };

async function subscription(
  stripeSubscriptionId: string | null,
  payment_source: 'stripe' | 'credits'
) {
  const user = await insertTestUser();
  await db.insert(kiloclaw_subscriptions).values({
    user_id: user.id,
    stripe_subscription_id: stripeSubscriptionId,
    payment_source,
    kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    plan: 'standard',
    status: 'active',
  });
  return user;
}

describe('admin Stripe renewal batch', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.resetAllMocks();
  });

  it('freezes all non-null Stripe subscription IDs, including stale hybrid rows, but excludes credit-only rows', async () => {
    await subscription('sub_hybrid', 'credits');
    await subscription(null, 'credits');
    const preview = await createStripeRenewalBatchPreview(actor);

    expect(preview.total).toBe(1);
    await subscription('sub_late', 'stripe');
    await startStripeRenewalBatch({ previewId: preview.id, actor });
    let calledAt = 0;
    jest.mocked(stopKiloClawStripeRenewal).mockImplementation(async () => {
      calledAt = Date.now();
      return { outcome: 'updated' };
    });
    const before = Date.now();
    await runStripeRenewalBatches();

    expect(stopKiloClawStripeRenewal).toHaveBeenCalledTimes(1);
    expect(stopKiloClawStripeRenewal).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: 'sub_hybrid', actor })
    );
    const [input] = jest.mocked(stopKiloClawStripeRenewal).mock.calls[0];
    expect(input.deadlineAtMs).toBeGreaterThan(before);
    expect(input.deadlineAtMs).toBeLessThanOrEqual(calledAt + 20_000);
    await expect(getStripeRenewalBatchStatus()).resolves.toEqual(
      expect.objectContaining({ run: expect.objectContaining({ updated: 1, failed: 0 }) })
    );
  });

  it('does not allow another actor to start a frozen preview', async () => {
    await subscription('sub_actor_bound', 'stripe');
    const preview = await createStripeRenewalBatchPreview(actor);

    await expect(
      startStripeRenewalBatch({
        previewId: preview.id,
        actor: { id: 'another-admin', email: 'other@example.com', name: null },
      })
    ).rejects.toThrow('Preview not found');
  });

  it('persists every page of a preview without dropping historical Stripe subscriptions', async () => {
    const user = await insertTestUser();
    await db.insert(kiloclaw_subscriptions).values(
      Array.from(
        { length: 501 },
        (_, index) =>
          ({
            user_id: user.id,
            stripe_subscription_id: `sub_page_${index}`,
            payment_source: 'stripe',
            kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
            plan: 'standard',
            status: 'canceled',
          }) satisfies typeof kiloclaw_subscriptions.$inferInsert
      )
    );

    const preview = await createStripeRenewalBatchPreview(actor);

    expect(preview.total).toBe(501);
    const [items] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.resource_key, preview.id),
          eq(operation_ledgers.intent, 'batch_item')
        )
      );
    expect(items.count).toBe(501);
    expect(stopKiloClawStripeRenewal).not.toHaveBeenCalled();
  });

  it('rejects an expired preview without starting any work', async () => {
    const preview = await createStripeRenewalBatchPreview(actor);
    await db
      .update(operation_ledgers)
      .set({
        canonical_result: sql`jsonb_set(canonical_result, '{previewExpiresAt}', '"2000-01-01T00:00:00.000Z"'::jsonb)`,
      })
      .where(
        and(
          eq(operation_ledgers.resource_key, preview.id),
          eq(operation_ledgers.intent, 'batch_header')
        )
      );

    await expect(startStripeRenewalBatch({ previewId: preview.id, actor })).rejects.toThrow(
      'Preview has expired'
    );
    await runStripeRenewalBatches();
    expect(stopKiloClawStripeRenewal).not.toHaveBeenCalled();
  });

  it('starts the same preview idempotently and does not reattribute an active run on retry', async () => {
    await subscription('sub_idempotent', 'stripe');
    const preview = await createStripeRenewalBatchPreview(actor);
    const input = { previewId: preview.id, actor };
    await startStripeRenewalBatch(input);
    await startStripeRenewalBatch(input);
    await retryStripeRenewalBatch(preview.id, {
      id: 'other-admin',
      email: 'other@example.com',
      name: null,
    });
    jest.mocked(stopKiloClawStripeRenewal).mockResolvedValue({ outcome: 'updated' });

    await runStripeRenewalBatches();

    expect(stopKiloClawStripeRenewal).toHaveBeenCalledTimes(1);
    expect(stopKiloClawStripeRenewal).toHaveBeenCalledWith(expect.objectContaining({ actor }));
    await retryStripeRenewalBatch(preview.id, actor);
    await expect(getStripeRenewalBatchStatus()).resolves.toEqual(
      expect.objectContaining({ run: expect.objectContaining({ status: 'completed' }) })
    );
  });

  it('requires superadmin access and the literal confirmation', async () => {
    const user = await insertTestUser({ is_admin: false });
    const caller = await createCallerForUser(user.id);

    await expect(caller.admin.kiloclawStripeRenewals.preview()).rejects.toThrow(
      'Admin access required'
    );

    const platformAdmin = await insertTestUser({ is_admin: true, is_super_admin: false });
    const platformCaller = await createCallerForUser(platformAdmin.id);
    await expect(platformCaller.admin.kiloclawStripeRenewals.preview()).rejects.toThrow(
      'Superadmin access required'
    );

    const admin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const adminCaller = await createCallerForUser(admin.id);
    await subscription('sub_confirmation', 'stripe');
    const preview = await adminCaller.admin.kiloclawStripeRenewals.preview();
    await expect(
      adminCaller.admin.kiloclawStripeRenewals.start({
        previewId: preview.id,
        confirmation: 'stop' as never,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(getStripeRenewalBatchStatus()).resolves.toEqual({ run: null });
    await adminCaller.admin.kiloclawStripeRenewals.start({
      previewId: preview.id,
      confirmation: 'STOP STRIPE RENEWALS',
    });
    await expect(getStripeRenewalBatchStatus()).resolves.toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ id: preview.id, status: 'running' }),
      })
    );
    const [header] = await db
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.resource_key, preview.id),
          eq(operation_ledgers.intent, 'batch_header')
        )
      );
    expect(header.canonical_result).toMatchObject({ reason: 'KiloClaw end of life' });
  });

  it('counts stale claims as attempts and exposes terminal failures for manual retry', async () => {
    await subscription('sub_retry', 'stripe');
    const preview = await createStripeRenewalBatchPreview(actor);
    await startStripeRenewalBatch({ previewId: preview.id, actor });
    (stopKiloClawStripeRenewal as jest.Mock).mockRejectedValue(new Error('Stripe unavailable'));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db
        .update(operation_ledgers)
        .set({
          lease_expires_at: sql`now() - interval '1 second'`,
          canonical_result: sql`jsonb_set(canonical_result, '{nextAttemptAt}', 'null'::jsonb)`,
        })
        .where(
          and(
            eq(operation_ledgers.resource_key, preview.id),
            eq(operation_ledgers.intent, 'batch_item')
          )
        );
      await runStripeRenewalBatches();
    }

    await runStripeRenewalBatches();
    await expect(getStripeRenewalBatchStatus()).resolves.toEqual(
      expect.objectContaining({
        run: expect.objectContaining({
          failed: 1,
          failures: [{ stripeSubscriptionId: 'sub_retry', error: 'Stripe unavailable' }],
        }),
      })
    );

    const retryActor = { id: 'retry-admin', email: 'retry@example.com', name: 'Retry Admin' };
    await retryStripeRenewalBatch(preview.id, retryActor);
    const [item] = await db
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.resource_key, preview.id),
          eq(operation_ledgers.intent, 'batch_item')
        )
      );
    expect(item).toEqual(expect.objectContaining({ status: 'admitted' }));
    const [header] = await db
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.resource_key, preview.id),
          eq(operation_ledgers.intent, 'batch_header')
        )
      );
    expect(header.canonical_result).toEqual(
      expect.objectContaining({
        actor: retryActor,
        initiator: actor,
        retriedAt: expect.any(String),
      })
    );
    (stopKiloClawStripeRenewal as jest.Mock).mockResolvedValue({ outcome: 'updated' });
    await runStripeRenewalBatches();
    expect(stopKiloClawStripeRenewal).toHaveBeenLastCalledWith(
      expect.objectContaining({ actor: retryActor })
    );
  });

  it('retries empty-message exceptions and records a terminal failure instead of success', async () => {
    await subscription('sub_empty_error', 'stripe');
    const preview = await createStripeRenewalBatchPreview(actor);
    await startStripeRenewalBatch({ previewId: preview.id, actor });
    jest.mocked(stopKiloClawStripeRenewal).mockRejectedValue(new Error(''));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db
        .update(operation_ledgers)
        .set({
          lease_expires_at: sql`now() - interval '1 second'`,
          canonical_result: sql`jsonb_set(canonical_result, '{nextAttemptAt}', 'null'::jsonb)`,
        })
        .where(
          and(
            eq(operation_ledgers.resource_key, preview.id),
            eq(operation_ledgers.intent, 'batch_item')
          )
        );
      await runStripeRenewalBatches();
    }
    expect(stopKiloClawStripeRenewal).toHaveBeenCalledTimes(3);
    await expect(getStripeRenewalBatchStatus()).resolves.toMatchObject({
      run: {
        status: 'failed',
        updated: 0,
        skipped: 0,
        failed: 1,
        processed: 1,
        failures: [
          {
            stripeSubscriptionId: 'sub_empty_error',
            error: 'Stripe renewal stop failed without an error message',
          },
        ],
      },
    });
  });

  it('purges expired preview manifests and retained terminal batches, never active or unrelated records', async () => {
    await subscription('sub_retention', 'stripe');
    const expired = await createStripeRenewalBatchPreview(actor);
    const terminal = await createStripeRenewalBatchPreview(actor);
    const active = await createStripeRenewalBatchPreview(actor);
    const fresh = await createStripeRenewalBatchPreview(actor);
    await startStripeRenewalBatch({ previewId: active.id, actor });
    await db
      .update(operation_ledgers)
      .set({
        canonical_result: sql`jsonb_set(canonical_result, '{previewExpiresAt}', '"2000-01-01T00:00:00.000Z"'::jsonb)`,
      })
      .where(
        and(
          eq(operation_ledgers.resource_key, expired.id),
          eq(operation_ledgers.intent, 'batch_header')
        )
      );
    await db
      .update(operation_ledgers)
      .set({
        status: 'completed',
        expires_at: '2000-01-01T00:00:00.000Z',
        canonical_result: sql`jsonb_set(canonical_result, '{state}', '"completed"'::jsonb)`,
      })
      .where(eq(operation_ledgers.resource_key, terminal.id));
    await db
      .update(operation_ledgers)
      .set({ expires_at: '2000-01-01T00:00:00.000Z' })
      .where(eq(operation_ledgers.resource_key, active.id));
    await db.insert(operation_ledgers).values({
      kilo_user_id: actor.id,
      domain: 'session',
      operation_key: 'unrelated-retention',
      intent: 'batch_header',
      resource_key: expired.id,
      taxonomy: 'safe-retry',
      status: 'completed',
      canonical_result: { state: 'completed' },
      admitted_at: new Date().toISOString(),
      lease_expires_at: '2000-01-01T00:00:00.000Z',
      expires_at: '2000-01-01T00:00:00.000Z',
    });

    await expect(purgeExpiredStripeRenewalBatches()).resolves.toBe(2);

    const rows = await db.select().from(operation_ledgers);
    expect(rows.filter(row => row.resource_key === expired.id)).toHaveLength(1);
    expect(rows.find(row => row.operation_key === 'unrelated-retention')).toBeDefined();
    expect(rows.filter(row => row.resource_key === terminal.id)).toHaveLength(0);
    expect(rows.filter(row => row.resource_key === active.id)).toHaveLength(2);
    expect(rows.filter(row => row.resource_key === fresh.id)).toHaveLength(2);
  });

  it('distinguishes expected input errors from private infrastructure failures', async () => {
    const admin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.kiloclawStripeRenewals.start({
        previewId: crypto.randomUUID(),
        confirmation: 'STOP STRIPE RENEWALS',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Preview not found' });
    const preview = await caller.admin.kiloclawStripeRenewals.preview();
    const transaction = jest
      .spyOn(db, 'transaction')
      .mockRejectedValueOnce(new Error('private database connection details'));
    try {
      await expect(
        caller.admin.kiloclawStripeRenewals.start({
          previewId: preview.id,
          confirmation: 'STOP STRIPE RENEWALS',
        })
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Unable to start Stripe renewal batch',
      });
      transaction.mockRejectedValueOnce(new Error('private database connection details'));
      await expect(
        caller.admin.kiloclawStripeRenewals.retry({ runId: preview.id })
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Unable to retry Stripe renewal batch',
      });
    } finally {
      transaction.mockRestore();
    }
  });

  it('does not call Stripe again when a stale claim has already exhausted its attempts', async () => {
    await subscription('sub_stale', 'stripe');
    const preview = await createStripeRenewalBatchPreview(actor);
    await startStripeRenewalBatch({ previewId: preview.id, actor });
    await db
      .update(operation_ledgers)
      .set({
        lease_expires_at: sql`now() - interval '1 second'`,
        canonical_result: sql`jsonb_set(jsonb_set(canonical_result, '{attempts}', '3'::jsonb), '{state}', '"processing"'::jsonb)`,
      })
      .where(
        and(
          eq(operation_ledgers.resource_key, preview.id),
          eq(operation_ledgers.intent, 'batch_item')
        )
      );

    await runStripeRenewalBatches();

    expect(stopKiloClawStripeRenewal).not.toHaveBeenCalled();
    await expect(getStripeRenewalBatchStatus()).resolves.toEqual(
      expect.objectContaining({ run: expect.objectContaining({ failed: 1 }) })
    );
  });

  it('does not promote an unstarted preview through retry', async () => {
    await subscription('sub_preview', 'stripe');
    const preview = await createStripeRenewalBatchPreview(actor);

    await expect(retryStripeRenewalBatch(preview.id, actor)).rejects.toThrow(
      'Preview has not been started'
    );
  });

  it('prevents a second admin preview from starting while a batch is running', async () => {
    await subscription('sub_running', 'stripe');
    const first = await createStripeRenewalBatchPreview(actor);
    await startStripeRenewalBatch({ previewId: first.id, actor });
    const secondActor = { id: 'admin-second', email: 'second@example.com', name: null };
    const second = await createStripeRenewalBatchPreview(secondActor);

    await expect(
      startStripeRenewalBatch({
        previewId: second.id,
        actor: secondActor,
      })
    ).rejects.toThrow('Another Stripe renewal batch is already running');
  });

  it('prioritizes an active retry over a newer completed run in status', async () => {
    await subscription('sub_first', 'stripe');
    const first = await createStripeRenewalBatchPreview(actor);
    await startStripeRenewalBatch({ previewId: first.id, actor });
    (stopKiloClawStripeRenewal as jest.Mock).mockResolvedValue({ outcome: 'updated' });
    await runStripeRenewalBatches();
    await runStripeRenewalBatches();

    await subscription('sub_second', 'stripe');
    const second = await createStripeRenewalBatchPreview(actor);
    await startStripeRenewalBatch({ previewId: second.id, actor });
    await runStripeRenewalBatches();
    await runStripeRenewalBatches();

    await db
      .update(operation_ledgers)
      .set({
        status: 'failed',
        canonical_result: sql`jsonb_set(canonical_result, '{state}', '"failed"'::jsonb)`,
      })
      .where(eq(operation_ledgers.resource_key, first.id));
    await retryStripeRenewalBatch(first.id, actor);

    await expect(getStripeRenewalBatchStatus()).resolves.toEqual(
      expect.objectContaining({ run: expect.objectContaining({ id: first.id, status: 'running' }) })
    );
  });
});
