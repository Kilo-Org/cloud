import { beforeEach, describe, expect, test } from '@jest/globals';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

import { db } from '@/lib/drizzle';
import {
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import { KiloPassCadence, KiloPassPaymentProvider, KiloPassTier } from '@/lib/kilo-pass/enums';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';

import { backfillGooglePlayPurchaseAmounts } from './store-purchase-money-backfill';

const PRODUCT_ID = 'kilopass_tier19';

type InsertedPurchase = { purchaseId: string };

async function insertPurchase(params: {
  providerTransactionId: string;
  purchasedAt: string;
  productId?: string;
  paymentProvider?: KiloPassPaymentProvider;
  money?: { amount: number; currency: string; tax: number };
}): Promise<InsertedPurchase> {
  const paymentProvider = params.paymentProvider ?? KiloPassPaymentProvider.GooglePlay;
  const user = await insertTestUser();
  const providerSubscriptionId = `play-sub-${crypto.randomUUID()}`;

  const [subscription] = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: user.id,
      payment_provider: paymentProvider,
      provider_subscription_id: providerSubscriptionId,
      stripe_subscription_id: null,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      current_streak_months: 1,
      next_yearly_issue_at: null,
    })
    .returning({ id: kilo_pass_subscriptions.id });

  const [purchase] = await db
    .insert(kilo_pass_store_purchases)
    .values({
      kilo_pass_subscription_id: subscription!.id,
      kilo_user_id: user.id,
      payment_provider: paymentProvider,
      product_id: params.productId ?? PRODUCT_ID,
      provider_subscription_id: providerSubscriptionId,
      provider_transaction_id: params.providerTransactionId,
      provider_original_transaction_id: providerSubscriptionId,
      app_account_token: user.app_store_account_token,
      environment: 'Sandbox',
      purchased_at: params.purchasedAt,
      expires_at: null,
      amount_charged_minor_units: params.money?.amount ?? null,
      currency: params.money?.currency ?? null,
      tax_minor_units: params.money?.tax ?? null,
      raw_payload_json: {},
    })
    .returning({ id: kilo_pass_store_purchases.id });

  return { purchaseId: purchase!.id };
}

async function readPurchase(purchaseId: string) {
  const row = await db.query.kilo_pass_store_purchases.findFirst({
    where: eq(kilo_pass_store_purchases.id, purchaseId),
  });
  if (!row) throw new Error(`Purchase ${purchaseId} not found`);
  return row;
}

function orderWithMoney(
  orderId: string,
  productId: string = PRODUCT_ID
): androidpublisher_v3.Schema$Order {
  return {
    orderId,
    purchaseToken: `play-token-${orderId}`,
    state: 'PROCESSED',
    lineItems: [
      {
        productId,
        total: { currencyCode: 'USD', units: '19', nanos: 0 },
        tax: { currencyCode: 'USD', units: '3', nanos: 170000000 },
      },
    ],
  };
}

function orderWithoutMoney(
  orderId: string,
  productId: string = PRODUCT_ID
): androidpublisher_v3.Schema$Order {
  return {
    orderId,
    purchaseToken: `play-token-${orderId}`,
    state: 'PROCESSED',
    lineItems: [{ productId }],
  };
}

/** Returns a fetcher that always answers with an order carrying 19.00 USD / 3.17 tax. */
function moneyFetcher(calls?: { count: number }) {
  return async (orderId: string): Promise<androidpublisher_v3.Schema$Order> => {
    if (calls) calls.count += 1;
    return orderWithMoney(orderId);
  };
}

describe('backfillGooglePlayPurchaseAmounts', () => {
  beforeEach(async () => {
    // Each test owns the whole table so `scanned` counts only its rows.
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_store_purchases);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_subscriptions);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  test('fills amount, currency, and tax from the purchase order', async () => {
    const { purchaseId } = await insertPurchase({
      providerTransactionId: 'GPA.happy',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await backfillGooglePlayPurchaseAmounts({
      orderFetcher: async orderId => {
        expect(orderId).toBe('GPA.happy');
        return orderWithMoney(orderId);
      },
    });

    expect(result).toEqual({ scanned: 1, updated: 1, skipped: 0, failed: 0, failures: [] });
    expect(await readPurchase(purchaseId)).toEqual(
      expect.objectContaining({
        amount_charged_minor_units: 1900,
        currency: 'USD',
        tax_minor_units: 317,
      })
    );
  });

  test('reports no work when there are no eligible rows', async () => {
    const result = await backfillGooglePlayPurchaseAmounts({
      orderFetcher: async () => {
        throw new Error('orderFetcher must not be called');
      },
    });

    expect(result).toEqual({ scanned: 0, updated: 0, skipped: 0, failed: 0, failures: [] });
  });

  test('counts a failed order lookup and still fills the other row', async () => {
    const failedRow = await insertPurchase({
      providerTransactionId: 'GPA.lookup-fails',
      purchasedAt: '2026-01-02T00:00:00.000Z',
    });
    const filledRow = await insertPurchase({
      providerTransactionId: 'GPA.lookup-succeeds',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await backfillGooglePlayPurchaseAmounts({
      orderFetcher: async orderId => {
        if (orderId === 'GPA.lookup-fails') throw new Error('Play order API unavailable');
        return orderWithMoney(orderId);
      },
    });

    expect(result).toEqual({
      scanned: 2,
      updated: 1,
      skipped: 0,
      failed: 1,
      failures: [
        {
          rowId: failedRow.purchaseId,
          orderId: 'GPA.lookup-fails',
          reason: 'Play order API unavailable',
        },
      ],
    });
    expect(await readPurchase(failedRow.purchaseId)).toEqual(
      expect.objectContaining({
        amount_charged_minor_units: null,
        currency: null,
        tax_minor_units: null,
      })
    );
    expect(await readPurchase(filledRow.purchaseId)).toEqual(
      expect.objectContaining({
        amount_charged_minor_units: 1900,
        currency: 'USD',
        tax_minor_units: 317,
      })
    );
  });

  test('records the failed row id, order id, and error message', async () => {
    const { purchaseId } = await insertPurchase({
      providerTransactionId: 'GPA.quota',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await backfillGooglePlayPurchaseAmounts({
      orderFetcher: async () => {
        throw new Error('quota exceeded for project kilo');
      },
    });

    expect(result).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
      failures: [
        {
          rowId: purchaseId,
          orderId: 'GPA.quota',
          reason: 'quota exceeded for project kilo',
        },
      ],
    });
  });

  test('attempts a no-money row once and leaves it out of later batches', async () => {
    const noMoneyRow = await insertPurchase({
      providerTransactionId: 'GPA.no-money',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });
    const appStoreRow = await insertPurchase({
      providerTransactionId: 'APPSTORE.no-money',
      purchasedAt: '2026-01-02T00:00:00.000Z',
      paymentProvider: KiloPassPaymentProvider.AppStore,
    });
    const alreadyFilledRow = await insertPurchase({
      providerTransactionId: 'GPA.already-filled',
      purchasedAt: '2026-01-03T00:00:00.000Z',
      money: { amount: 500, currency: 'USD', tax: 75 },
    });
    const calls = { count: 0 };

    const first = await backfillGooglePlayPurchaseAmounts({
      orderFetcher: async orderId => {
        calls.count += 1;
        return orderWithoutMoney(orderId);
      },
    });
    expect(first).toEqual({ scanned: 1, updated: 0, skipped: 1, failed: 0, failures: [] });

    const second = await backfillGooglePlayPurchaseAmounts({
      orderFetcher: async orderId => {
        calls.count += 1;
        return orderWithoutMoney(orderId);
      },
    });
    // Play has no money for this order, so the row is retired after one attempt:
    // the batch converges to nothing to do instead of re-reading it every run.
    expect(second).toEqual({ scanned: 0, updated: 0, skipped: 0, failed: 0, failures: [] });
    expect(calls.count).toBe(1);

    expect(await readPurchase(noMoneyRow.purchaseId)).toEqual(
      expect.objectContaining({
        amount_charged_minor_units: null,
        currency: null,
        tax_minor_units: null,
      })
    );
    // Only google_play rows with NULL money are scanned: the App Store row and
    // the already-filled Google Play row are never even selected.
    expect(await readPurchase(appStoreRow.purchaseId)).toEqual(
      expect.objectContaining({
        amount_charged_minor_units: null,
        currency: null,
        tax_minor_units: null,
      })
    );
    expect(await readPurchase(alreadyFilledRow.purchaseId)).toEqual(
      expect.objectContaining({
        amount_charged_minor_units: 500,
        currency: 'USD',
        tax_minor_units: 75,
      })
    );
  });

  test('converges past a no-money row within a bounded batch', async () => {
    const noMoneyRow = await insertPurchase({
      providerTransactionId: 'GPA.newest-no-money',
      purchasedAt: '2026-01-02T00:00:00.000Z',
    });
    const moneyRow = await insertPurchase({
      providerTransactionId: 'GPA.older-with-money',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });
    const fetcher = async (orderId: string) =>
      orderId === 'GPA.newest-no-money' ? orderWithoutMoney(orderId) : orderWithMoney(orderId);

    const first = await backfillGooglePlayPurchaseAmounts({ limit: 1, orderFetcher: fetcher });
    expect(first).toEqual({ scanned: 1, updated: 0, skipped: 1, failed: 0, failures: [] });

    // The skipped no-money row must not block the next batch from reaching the
    // older row, or a `--limit` run would never get past it.
    const second = await backfillGooglePlayPurchaseAmounts({ limit: 1, orderFetcher: fetcher });
    expect(second).toEqual({ scanned: 1, updated: 1, skipped: 0, failed: 0, failures: [] });
    expect((await readPurchase(moneyRow.purchaseId)).amount_charged_minor_units).toBe(1900);

    const third = await backfillGooglePlayPurchaseAmounts({ limit: 1, orderFetcher: fetcher });
    expect(third).toEqual({ scanned: 0, updated: 0, skipped: 0, failed: 0, failures: [] });
    expect((await readPurchase(noMoneyRow.purchaseId)).amount_charged_minor_units).toBeNull();
  });

  test('retries a failed lookup in the next batch so it is never abandoned', async () => {
    const { purchaseId } = await insertPurchase({
      providerTransactionId: 'GPA.retry',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });

    const first = await backfillGooglePlayPurchaseAmounts({
      orderFetcher: async () => {
        throw new Error('Play order API unavailable');
      },
    });
    expect(first).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
      failures: [{ rowId: purchaseId, orderId: 'GPA.retry', reason: 'Play order API unavailable' }],
    });

    const second = await backfillGooglePlayPurchaseAmounts({ orderFetcher: moneyFetcher() });
    expect(second).toEqual({ scanned: 1, updated: 1, skipped: 0, failed: 0, failures: [] });
    expect((await readPurchase(purchaseId)).amount_charged_minor_units).toBe(1900);
  });

  test('does not modify an already-filled row on a second run', async () => {
    const { purchaseId } = await insertPurchase({
      providerTransactionId: 'GPA.idempotent',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });
    const calls = { count: 0 };

    const first = await backfillGooglePlayPurchaseAmounts({ orderFetcher: moneyFetcher(calls) });
    expect(first).toEqual({ scanned: 1, updated: 1, skipped: 0, failed: 0, failures: [] });

    const second = await backfillGooglePlayPurchaseAmounts({ orderFetcher: moneyFetcher(calls) });
    expect(second).toEqual({ scanned: 0, updated: 0, skipped: 0, failed: 0, failures: [] });
    expect(calls.count).toBe(1);

    expect(await readPurchase(purchaseId)).toEqual(
      expect.objectContaining({
        amount_charged_minor_units: 1900,
        currency: 'USD',
        tax_minor_units: 317,
      })
    );
  });

  test('bounds each batch by limit and resumes with the remaining rows', async () => {
    const oldest = await insertPurchase({
      providerTransactionId: 'GPA.oldest',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });
    const middle = await insertPurchase({
      providerTransactionId: 'GPA.middle',
      purchasedAt: '2026-01-02T00:00:00.000Z',
    });
    const newest = await insertPurchase({
      providerTransactionId: 'GPA.newest',
      purchasedAt: '2026-01-03T00:00:00.000Z',
    });

    const first = await backfillGooglePlayPurchaseAmounts({
      limit: 2,
      orderFetcher: moneyFetcher(),
    });
    expect(first).toEqual({ scanned: 2, updated: 2, skipped: 0, failed: 0, failures: [] });
    expect((await readPurchase(newest.purchaseId)).amount_charged_minor_units).toBe(1900);
    expect((await readPurchase(middle.purchaseId)).amount_charged_minor_units).toBe(1900);
    expect((await readPurchase(oldest.purchaseId)).amount_charged_minor_units).toBeNull();

    const second = await backfillGooglePlayPurchaseAmounts({
      limit: 2,
      orderFetcher: moneyFetcher(),
    });
    expect(second).toEqual({ scanned: 1, updated: 1, skipped: 0, failed: 0, failures: [] });
    expect((await readPurchase(oldest.purchaseId)).amount_charged_minor_units).toBe(1900);
  });

  test('counts a dry run without writing', async () => {
    const { purchaseId } = await insertPurchase({
      providerTransactionId: 'GPA.dry-run',
      purchasedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await backfillGooglePlayPurchaseAmounts({
      orderFetcher: moneyFetcher(),
      dryRun: true,
    });

    expect(result).toEqual({ scanned: 1, updated: 1, skipped: 0, failed: 0, failures: [] });
    expect((await readPurchase(purchaseId)).amount_charged_minor_units).toBeNull();
  });
});
