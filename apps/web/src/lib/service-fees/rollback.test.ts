import { beforeEach, describe, expect, test } from '@jest/globals';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';

import { service_fee_rollback_refunds, stripe_service_fee_assessments } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import {
  buildServiceFeeRefundAllocationMetadata,
  parseServiceFeeRefundAllocationMetadata,
} from '@/lib/service-fees/refunds';
import {
  SERVICE_FEE_ROLLBACK_MAX_ATTEMPTS,
  SERVICE_FEE_ROLLBACK_METADATA_KEY,
  SERVICE_FEE_ROLLBACK_STALE_PENDING_MS,
  executeServiceFeeRollbackBatch,
  getServiceFeeRollbackOverview,
  reconcileStaleServiceFeeRollbackClaims,
  serviceFeeRollbackIdempotencyKey,
  type ServiceFeeRollbackStripeClient,
} from '@/lib/service-fees/rollback';

type FakeCharge = { id: string; amount: number; amount_refunded: number; currency: string };
type CreateCall = { params: Stripe.RefundCreateParams; idempotencyKey: string };

type CreateErrorFactory = (params: Stripe.RefundCreateParams) => Error | undefined;

function createFakeStripe(
  options: {
    createError?: CreateErrorFactory;
    createDelayMs?: number;
    refundStatus?: Stripe.Refund['status'];
    beforeCreate?: () => Promise<void>;
  } = {}
) {
  const charges = new Map<string, FakeCharge>();
  const refunds = new Map<string, Stripe.Refund[]>();
  const paymentIntents = new Map<string, string>();
  const creates: CreateCall[] = [];
  const idempotent = new Map<string, Stripe.Refund>();
  let createError = options.createError;

  const addRefund = (chargeId: string, refund: Partial<Stripe.Refund> & { amount: number }) => {
    const created = {
      id: `re_${crypto.randomUUID()}`,
      object: 'refund',
      status: 'succeeded',
      metadata: {},
      charge: chargeId,
      ...refund,
    } as Stripe.Refund;
    refunds.set(chargeId, [...(refunds.get(chargeId) ?? []), created]);
    const charge = charges.get(chargeId);
    if (charge && created.status !== 'failed') charge.amount_refunded += created.amount;
    return created;
  };

  const client = {
    charges: {
      retrieve: async (id: string) => {
        const charge = charges.get(id);
        if (!charge) throw new Error(`unknown charge ${id}`);
        return { ...charge };
      },
    },
    paymentIntents: {
      retrieve: async (id: string) => ({ id, latest_charge: paymentIntents.get(id) ?? null }),
    },
    refunds: {
      list: async (params: Stripe.RefundListParams) => ({
        data: refunds.get(params.charge ?? '') ?? [],
        has_more: false,
      }),
      create: async (params: Stripe.RefundCreateParams, requestOptions: Stripe.RequestOptions) => {
        const idempotencyKey = requestOptions.idempotencyKey ?? '';
        if (options.createDelayMs) {
          await new Promise(resolve => setTimeout(resolve, options.createDelayMs));
        }
        const replay = idempotent.get(idempotencyKey);
        if (replay) return replay;
        creates.push({ params, idempotencyKey });
        await options.beforeCreate?.();
        const error = createError?.(params);
        if (error) throw error;
        const refund = addRefund(params.charge ?? '', {
          amount: params.amount ?? 0,
          metadata: params.metadata as Stripe.Metadata,
          status: options.refundStatus ?? 'succeeded',
        });
        idempotent.set(idempotencyKey, refund);
        return refund;
      },
    },
  } as unknown as ServiceFeeRollbackStripeClient;

  return {
    client,
    charges,
    paymentIntents,
    creates,
    addRefund,
    refunds,
    setCreateError: (factory: CreateErrorFactory | undefined) => {
      createError = factory;
    },
  };
}

async function seedChargedFee(params: {
  kiloUserId: string;
  stripe: ReturnType<typeof createFakeStripe>;
  feeMinor?: number;
  productMinor?: number;
  refundedFeeMinor?: number;
  disputedFeeMinor?: number;
  linkCharge?: boolean;
}) {
  const feeMinor = params.feeMinor ?? 250;
  const productMinor = params.productMinor ?? 5_000;
  const assessmentKey = `checkout:${crypto.randomUUID()}`;
  const chargeId = `ch_${crypto.randomUUID()}`;
  const paymentIntentId = `pi_${crypto.randomUUID()}`;
  params.stripe.charges.set(chargeId, {
    id: chargeId,
    amount: productMinor + feeMinor,
    amount_refunded: 0,
    currency: 'usd',
  });
  params.stripe.paymentIntents.set(paymentIntentId, chargeId);
  await db.insert(stripe_service_fee_assessments).values({
    assessment_key: assessmentKey,
    version: 'test',
    flow: 'personal_top_up',
    outcome: 'charged',
    currency: 'usd',
    kilo_user_id: params.kiloUserId,
    stripe_charge_id: params.linkCharge === false ? null : chargeId,
    stripe_payment_intent_id: paymentIntentId,
    eligibility_created_at: '2026-11-01T12:00:00.000Z',
    eligible_subtotal_minor: productMinor,
    expected_fee_minor: feeMinor,
    charged_fee_minor: feeMinor,
    gross_paid_minor: productMinor + feeMinor,
    settled_product_minor: productMinor,
    refunded_fee_minor: params.refundedFeeMinor ?? 0,
    disputed_fee_minor: params.disputedFeeMinor ?? 0,
    settled_at: '2026-11-01T12:01:00.000Z',
  });
  return { assessmentKey, chargeId, feeMinor };
}

async function claimFor(assessmentKey: string) {
  return db.query.service_fee_rollback_refunds.findFirst({
    where: eq(service_fee_rollback_refunds.assessment_key, assessmentKey),
  });
}

function stripeRejection(message: string, code?: string): Error {
  return new Stripe.errors.StripeInvalidRequestError({
    message,
    type: 'invalid_request_error',
    statusCode: 400,
    code,
  } as ConstructorParameters<typeof Stripe.errors.StripeInvalidRequestError>[0]);
}

function runBatch(stripe: ReturnType<typeof createFakeStripe>, limit = 10) {
  return executeServiceFeeRollbackBatch({
    database: db,
    stripe: stripe.client,
    adminKiloUserId: adminId,
    limit,
  });
}

let adminId: string;
let customerId: string;

beforeEach(async () => {
  await cleanupDbForTest();
  adminId = (await insertTestUser()).id;
  customerId = (await insertTestUser()).id;
});

describe('executeServiceFeeRollbackBatch', () => {
  test('refunds only the fee with allocation metadata and never refunds it twice', async () => {
    const stripe = createFakeStripe();
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });

    const first = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });

    expect(first).toEqual([
      expect.objectContaining({
        assessmentKey: seeded.assessmentKey,
        status: 'refunded',
        amountMinor: seeded.feeMinor,
        stripeChargeId: seeded.chargeId,
      }),
    ]);
    expect(stripe.creates).toHaveLength(1);
    const [call] = stripe.creates;
    expect(call.idempotencyKey).toBe(serviceFeeRollbackIdempotencyKey(seeded.assessmentKey, 1));
    expect(call.params).toMatchObject({ charge: seeded.chargeId, amount: seeded.feeMinor });
    expect(
      parseServiceFeeRefundAllocationMetadata(call.params.metadata as Stripe.Metadata)
    ).toEqual({ productMinor: 0, feeMinor: seeded.feeMinor });
    expect(call.params.metadata).toMatchObject({
      [SERVICE_FEE_ROLLBACK_METADATA_KEY]: seeded.assessmentKey,
    });
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({
      status: 'succeeded',
      amount_minor: seeded.feeMinor,
      stripe_refund_id: first[0].stripeRefundId,
      requested_by_kilo_user_id: adminId,
    });

    const second = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });
    expect(second).toEqual([]);
    expect(stripe.creates).toHaveLength(1);
  });

  test('concurrent batches refund each fee once', async () => {
    const stripe = createFakeStripe({ createDelayMs: 20 });
    await seedChargedFee({ kiloUserId: customerId, stripe });
    await seedChargedFee({ kiloUserId: customerId, stripe });

    const [a, b] = await Promise.all([
      executeServiceFeeRollbackBatch({
        database: db,
        stripe: stripe.client,
        adminKiloUserId: adminId,
        limit: 10,
      }),
      executeServiceFeeRollbackBatch({
        database: db,
        stripe: stripe.client,
        adminKiloUserId: adminId,
        limit: 10,
      }),
    ]);

    expect(stripe.creates).toHaveLength(2);
    const refunded = [...a, ...b].filter(row => row.status === 'refunded');
    expect(refunded).toHaveLength(2);
    expect(new Set(refunded.map(row => row.assessmentKey)).size).toBe(2);
  });

  test('records an existing rollback refund found on Stripe instead of refunding again', async () => {
    const stripe = createFakeStripe();
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });
    const existing = stripe.addRefund(seeded.chargeId, {
      amount: seeded.feeMinor,
      metadata: {
        ...buildServiceFeeRefundAllocationMetadata({ productMinor: 0, feeMinor: seeded.feeMinor }),
        [SERVICE_FEE_ROLLBACK_METADATA_KEY]: seeded.assessmentKey,
      },
    });

    const results = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });

    expect(results[0]).toMatchObject({ status: 'already_refunded', stripeRefundId: existing.id });
    expect(stripe.creates).toHaveLength(0);
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({
      status: 'succeeded',
      stripe_refund_id: existing.id,
    });
  });

  test('skips a charge with a refund that carries no fee allocation', async () => {
    const stripe = createFakeStripe();
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });
    stripe.addRefund(seeded.chargeId, { amount: 1_000 });

    const results = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });

    expect(results[0]).toMatchObject({ status: 'skipped' });
    expect(stripe.creates).toHaveLength(0);
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({ status: 'skipped' });
  });

  test('refunds only the unrefunded part of the fee and caps at the charge balance', async () => {
    const stripe = createFakeStripe();
    const partial = await seedChargedFee({ kiloUserId: customerId, stripe, feeMinor: 500 });
    stripe.addRefund(partial.chargeId, {
      amount: 200,
      metadata: buildServiceFeeRefundAllocationMetadata({ productMinor: 0, feeMinor: 200 }),
    });
    const nearlyRefunded = await seedChargedFee({ kiloUserId: customerId, stripe, feeMinor: 500 });
    const charge = stripe.charges.get(nearlyRefunded.chargeId);
    if (!charge) throw new Error('missing fake charge');
    charge.amount_refunded = charge.amount - 100;

    await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });

    const amounts = new Map(stripe.creates.map(call => [call.params.charge, call.params.amount]));
    expect(amounts.get(partial.chargeId)).toBe(300);
    expect(amounts.get(nearlyRefunded.chargeId)).toBe(100);
  });

  test('skips a disputed fee', async () => {
    const stripe = createFakeStripe();
    const seeded = await seedChargedFee({
      kiloUserId: customerId,
      stripe,
      feeMinor: 500,
      disputedFeeMinor: 100,
    });

    const results = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });

    expect(results[0]).toMatchObject({ assessmentKey: seeded.assessmentKey, status: 'skipped' });
    expect(stripe.creates).toHaveLength(0);
  });

  test('resolves the charge from the payment intent when the charge is not linked', async () => {
    const stripe = createFakeStripe();
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe, linkCharge: false });

    const results = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });

    expect(results[0]).toMatchObject({ status: 'refunded', stripeChargeId: seeded.chargeId });
  });

  test('a definite Stripe rejection fails the claim and the next batch retries with a new key', async () => {
    const stripe = createFakeStripe({ createError: () => stripeRejection('card closed') });
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });

    const failed = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });
    expect(failed[0]).toMatchObject({ status: 'failed', reason: 'card closed' });
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({ status: 'failed', attempt: 1 });

    stripe.setCreateError(undefined);
    const retried = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });

    expect(retried[0]).toMatchObject({ status: 'refunded' });
    expect(stripe.creates.map(call => call.idempotencyKey)).toEqual([
      serviceFeeRollbackIdempotencyKey(seeded.assessmentKey, 1),
      serviceFeeRollbackIdempotencyKey(seeded.assessmentKey, 2),
    ]);
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
  });

  test('an ambiguous Stripe error leaves the claim pending and out of later batches', async () => {
    const stripe = createFakeStripe({ createError: () => new Error('socket hang up') });
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });

    const results = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });
    expect(results[0]).toMatchObject({ status: 'outcome_unknown' });
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({ status: 'pending' });

    stripe.setCreateError(undefined);
    const again = await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });
    expect(again).toEqual([]);
    expect(stripe.creates).toHaveLength(1);
  });
});

describe('executeServiceFeeRollbackBatch retry handling', () => {
  test('refunds never-claimed fees before retrying failed ones and gives up after the cap', async () => {
    let failingChargeId = '';
    const stripe = createFakeStripe({
      createError: params =>
        params.charge === failingChargeId ? stripeRejection('card closed') : undefined,
    });
    const failing = await seedChargedFee({ kiloUserId: customerId, stripe });
    failingChargeId = failing.chargeId;

    expect((await runBatch(stripe, 1))[0]).toMatchObject({
      assessmentKey: failing.assessmentKey,
      status: 'failed',
    });

    const fresh = await seedChargedFee({ kiloUserId: customerId, stripe });
    expect((await runBatch(stripe, 1))[0]).toMatchObject({
      assessmentKey: fresh.assessmentKey,
      status: 'refunded',
    });

    expect((await runBatch(stripe, 1))[0]).toMatchObject({ status: 'failed' });
    expect((await runBatch(stripe, 1))[0]).toMatchObject({
      assessmentKey: failing.assessmentKey,
      status: 'skipped',
      reason: expect.stringContaining('Gave up after Stripe rejected the refund 3 times'),
    });
    expect(await runBatch(stripe, 1)).toEqual([]);
    expect(await claimFor(failing.assessmentKey)).toMatchObject({
      status: 'skipped',
      attempt: 3,
      rejected_attempts: 3,
    });
  });

  test('failures before the refund request do not use up the retry cap', async () => {
    const stripe = createFakeStripe();
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });
    const charge = stripe.charges.get(seeded.chargeId);
    if (!charge) throw new Error('missing fake charge');
    stripe.charges.delete(seeded.chargeId);

    for (let run = 0; run < SERVICE_FEE_ROLLBACK_MAX_ATTEMPTS + 1; run++) {
      expect((await runBatch(stripe))[0]).toMatchObject({ status: 'failed' });
    }
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({
      status: 'failed',
      rejected_attempts: 0,
    });
    expect(stripe.creates).toHaveLength(0);

    stripe.charges.set(seeded.chargeId, charge);
    expect((await runBatch(stripe))[0]).toMatchObject({ status: 'refunded' });
  });

  test('skips immediately on a Stripe rejection that cannot succeed on retry', async () => {
    const stripe = createFakeStripe({
      createError: () => stripeRejection('Charge has been disputed', 'charge_disputed'),
    });
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });

    expect((await runBatch(stripe))[0]).toMatchObject({ status: 'skipped' });
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({ status: 'skipped', attempt: 1 });
    expect(await runBatch(stripe)).toEqual([]);
  });

  test('does not overwrite a claim that changed while the attempt was running', async () => {
    let assessmentKey = '';
    const stripe = createFakeStripe({
      beforeCreate: async () => {
        await db
          .update(service_fee_rollback_refunds)
          .set({ status: 'failed', reason: 'Reconciled: no rollback refund found on the charge' })
          .where(eq(service_fee_rollback_refunds.assessment_key, assessmentKey));
      },
    });
    assessmentKey = (await seedChargedFee({ kiloUserId: customerId, stripe })).assessmentKey;

    const [result] = await runBatch(stripe);

    expect(result).toMatchObject({ status: 'claimed_elsewhere' });
    expect(await claimFor(assessmentKey)).toMatchObject({
      status: 'failed',
      stripe_refund_id: null,
    });
  });

  test('keeps a refund that has not completed pending until reconcile sees it settle', async () => {
    const stripe = createFakeStripe({ refundStatus: 'requires_action' });
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });

    const [result] = await runBatch(stripe);
    expect(result).toMatchObject({ status: 'outcome_unknown' });
    expect(result.stripeRefundId).not.toBeNull();
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({
      status: 'pending',
      stripe_refund_id: result.stripeRefundId,
    });
    expect(await runBatch(stripe)).toEqual([]);

    const later = new Date(Date.now() + SERVICE_FEE_ROLLBACK_STALE_PENDING_MS + 60_000);
    expect(
      await reconcileStaleServiceFeeRollbackClaims({
        database: db,
        stripe: stripe.client,
        now: later,
      })
    ).toEqual([expect.objectContaining({ status: 'pending' })]);

    const [refund] = stripe.refunds.get(seeded.chargeId) ?? [];
    refund.status = 'succeeded';
    expect(
      await reconcileStaleServiceFeeRollbackClaims({
        database: db,
        stripe: stripe.client,
        now: later,
      })
    ).toEqual([expect.objectContaining({ status: 'succeeded', stripeRefundId: refund.id })]);
  });
});

describe('reconcileStaleServiceFeeRollbackClaims', () => {
  const later = () => new Date(Date.now() + SERVICE_FEE_ROLLBACK_STALE_PENDING_MS + 60_000);

  test('marks a stale pending claim succeeded when its refund exists on Stripe', async () => {
    const stripe = createFakeStripe({ createError: () => new Error('timeout') });
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });
    await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });
    const landed = stripe.addRefund(seeded.chargeId, {
      amount: seeded.feeMinor,
      metadata: { [SERVICE_FEE_ROLLBACK_METADATA_KEY]: seeded.assessmentKey },
    });

    expect(
      await reconcileStaleServiceFeeRollbackClaims({ database: db, stripe: stripe.client })
    ).toEqual([]);

    const results = await reconcileStaleServiceFeeRollbackClaims({
      database: db,
      stripe: stripe.client,
      now: later(),
    });

    expect(results).toEqual([
      expect.objectContaining({ status: 'succeeded', stripeRefundId: landed.id }),
    ]);
    expect(await claimFor(seeded.assessmentKey)).toMatchObject({
      status: 'succeeded',
      stripe_refund_id: landed.id,
      amount_minor: seeded.feeMinor,
    });
  });

  test('marks a stale pending claim failed when no refund exists so it can be retried', async () => {
    const stripe = createFakeStripe({ createError: () => new Error('timeout') });
    const seeded = await seedChargedFee({ kiloUserId: customerId, stripe });
    await executeServiceFeeRollbackBatch({
      database: db,
      stripe: stripe.client,
      adminKiloUserId: adminId,
      limit: 10,
    });

    const results = await reconcileStaleServiceFeeRollbackClaims({
      database: db,
      stripe: stripe.client,
      now: later(),
    });

    expect(results).toEqual([expect.objectContaining({ status: 'failed' })]);
    const overview = await getServiceFeeRollbackOverview(db);
    expect(overview.candidates.map(row => row.assessmentKey)).toEqual([seeded.assessmentKey]);
  });
});

describe('getServiceFeeRollbackOverview', () => {
  test('summarizes remaining fees and lists unsettled fees separately', async () => {
    const stripe = createFakeStripe();
    await seedChargedFee({ kiloUserId: customerId, stripe, feeMinor: 250 });
    await seedChargedFee({ kiloUserId: customerId, stripe, feeMinor: 500, refundedFeeMinor: 500 });
    await db.insert(stripe_service_fee_assessments).values({
      assessment_key: `invoice:${crypto.randomUUID()}`,
      version: 'test',
      flow: 'personal_auto_top_up',
      outcome: 'charged',
      currency: 'usd',
      kilo_user_id: customerId,
      stripe_invoice_id: 'in_unsettled',
      stripe_invoice_fee_item_id: `ii_${crypto.randomUUID()}`,
      eligibility_created_at: '2026-11-01T12:00:00.000Z',
      eligible_subtotal_minor: 2_000,
      expected_fee_minor: 100,
      charged_fee_minor: 100,
    });

    const overview = await getServiceFeeRollbackOverview(db);

    expect(overview.remaining).toEqual({ count: 1, amountMinor: 250 });
    expect(overview.unsettledWithFee).toEqual([
      expect.objectContaining({ stripeInvoiceId: 'in_unsettled', chargedFeeMinor: 100 }),
    ]);
  });
});
