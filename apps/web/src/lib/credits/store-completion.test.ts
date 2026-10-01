import { NotificationTypeV2 } from '@apple/app-store-server-library';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { and, eq, sql } from 'drizzle-orm';

import {
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_store_events,
  kilocode_users,
} from '@kilocode/db/schema';
import type * as Credits from '@/lib/credits';
import { db } from '@/lib/drizzle';
import { toMicrodollars } from '@/lib/microdollars';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { insertTestUser } from '@/tests/helpers/user.helper';

import type * as StoreCompletion from './store-completion';
import type { ValidatedStoreCreditPurchase } from './store-verifier';
import { storeCreditPaymentId } from './store-products';
import { googlePlayCreditProviderTransactionId } from './store-verifier';
import {
  lockStoreCreditPurchase,
  restoreStoreCreditPurchase,
  reverseStoreCreditPurchase,
  STORE_FULL_MILLIUNITS,
  STORE_PURCHASE_REFUNDED_MESSAGE,
} from './store-refund';

// SWC + static ESM imports do not see jest.mock replacements on the same module
// id. The real top-up runs against the test database by default; one test makes
// it report an already-credited transaction that does not exist, to prove the
// inconsistent-ledger path.
jest.mock('@/lib/credits', () => {
  const actual = jest.requireActual<typeof Credits>('@/lib/credits');
  return {
    __esModule: true,
    ...actual,
    processTopUp: jest.fn(actual.processTopUp),
  };
});

jest.mock('@/lib/bouncer/client', () => ({
  __esModule: true,
  ...jest.requireActual<object>('@/lib/bouncer/client'),
  reportCreditEvent: jest.fn(),
}));

const mockReportCreditEvent = jest.mocked(
  jest.requireMock<{ reportCreditEvent: jest.Mock }>('@/lib/bouncer/client').reportCreditEvent
);

const mockProcessTopUp = jest.mocked(
  jest.requireMock<typeof Credits>('@/lib/credits').processTopUp
);

let completeStoreCreditPurchase: typeof StoreCompletion.completeStoreCreditPurchase;
let reportStoreCreditPurchaseToBouncer: typeof StoreCompletion.reportStoreCreditPurchaseToBouncer;

beforeAll(() => {
  // Loaded here rather than through a static import for the same reason: a
  // static import is bound before the mock above is registered.
  ({ completeStoreCreditPurchase, reportStoreCreditPurchaseToBouncer } =
    jest.requireActual<typeof StoreCompletion>('./store-completion'));
});

beforeEach(() => {
  mockProcessTopUp.mockClear();
  mockReportCreditEvent.mockClear();
});

function purchase(
  overrides: Partial<ValidatedStoreCreditPurchase> = {}
): ValidatedStoreCreditPurchase {
  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: 'credits.usd10.v1',
    providerTransactionId: `tx-${crypto.randomUUID()}`,
    appAccountToken: null,
    quantity: 1,
    amountUsd: 10,
    amountMicrodollars: toMicrodollars(10),
    purchasedAtIso: '2026-06-01T09:00:00.000Z',
    environment: 'Sandbox',
    rawPayload: {},
    ...overrides,
  };
}

function playPurchase(
  providerTransactionId: string,
  overrides: Partial<ValidatedStoreCreditPurchase> = {}
): ValidatedStoreCreditPurchase {
  return purchase({
    paymentProvider: KiloPassPaymentProvider.GooglePlay,
    productId: 'credits_usd10',
    providerTransactionId,
    ...overrides,
  });
}

/**
 * The event row a notification handler writes when it claims a refund, in the
 * shape both claim helpers store: the decoded notification type and the store's
 * signed date in `payload_json`, the store ids in their own columns.
 */
async function insertRefundEvent(params: {
  paymentProvider: KiloPassPaymentProvider;
  notificationType: string;
  providerTransactionId: string;
  providerSubscriptionId?: string;
  signedDate?: number | null;
  processed: boolean;
  processedAt?: string;
}): Promise<string> {
  const eventId = `event-${crypto.randomUUID()}`;
  await db.insert(kilo_pass_store_events).values({
    payment_provider: params.paymentProvider,
    event_id: eventId,
    provider_transaction_id: params.providerTransactionId,
    provider_subscription_id: params.providerSubscriptionId ?? null,
    product_id: 'credits.usd10.v1',
    environment: 'Sandbox',
    payload_json: {
      notificationType: params.notificationType,
      signedDate: params.signedDate ?? null,
    },
    processing_started_at: new Date().toISOString(),
    processed_at: params.processed ? (params.processedAt ?? new Date().toISOString()) : null,
  });
  return eventId;
}

function creditRowsForPayment(paymentId: string) {
  return db
    .select({
      id: credit_transactions.id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      kiloUserId: credit_transactions.kilo_user_id,
      description: credit_transactions.description,
      isFree: credit_transactions.is_free,
      creditCategory: credit_transactions.credit_category,
    })
    .from(credit_transactions)
    .where(eq(credit_transactions.stripe_payment_id, paymentId));
}

async function balanceOf(userId: string): Promise<number> {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
  return user?.total_microdollars_acquired ?? 0;
}

describe('completeStoreCreditPurchase', () => {
  it('grants the catalog amount with the store idempotency key', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const storePurchase = purchase({ providerTransactionId, appAccountToken: null });

    const result = await completeStoreCreditPurchase({ user, purchase: storePurchase });

    expect(result).toEqual({
      alreadyProcessed: false,
      amountUsd: 10,
      amountMicrodollars: toMicrodollars(10),
      creditTransactionId: expect.any(String),
    });
    expect(
      await creditRowsForPayment(
        storeCreditPaymentId(KiloPassPaymentProvider.AppStore, providerTransactionId)
      )
    ).toEqual([
      expect.objectContaining({
        id: result.creditTransactionId,
        amountMicrodollars: toMicrodollars(10),
        kiloUserId: user.id,
        description: 'Credit purchase via App Store',
        isFree: false,
        creditCategory: null,
      }),
    ]);
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));
    const audit = await db.query.kilo_pass_audit_log.findMany({
      where: eq(kilo_pass_audit_log.kilo_user_id, user.id),
    });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'store_purchase_completed',
        result: 'success',
        related_credit_transaction_id: result.creditTransactionId,
        payload_json: expect.objectContaining({
          kind: 'store_credit_pack',
          providerTransactionId,
          amountUsd: 10,
        }),
      }),
    ]);
  });

  it('describes a Google Play grant as such', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `GPA.${crypto.randomUUID()}`;

    await completeStoreCreditPurchase({
      user,
      purchase: playPurchase(providerTransactionId),
    });

    expect(
      await creditRowsForPayment(
        storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, providerTransactionId)
      )
    ).toEqual([expect.objectContaining({ description: 'Credit purchase via Google Play' })]);
  });

  it('reports a replay as already processed without a second grant', async () => {
    const user = await insertTestUser();
    const storePurchase = purchase();

    const granted = await completeStoreCreditPurchase({ user, purchase: storePurchase });
    const replayed = await completeStoreCreditPurchase({ user, purchase: storePurchase });

    expect(replayed).toEqual({
      alreadyProcessed: true,
      amountUsd: 10,
      amountMicrodollars: toMicrodollars(10),
      creditTransactionId: granted.creditTransactionId,
    });
    expect(
      await creditRowsForPayment(
        storeCreditPaymentId(storePurchase.paymentProvider, storePurchase.providerTransactionId)
      )
    ).toHaveLength(1);
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));
    // A replay grants nothing, so it audits nothing.
    expect(
      await db.query.kilo_pass_audit_log.findMany({
        where: eq(kilo_pass_audit_log.kilo_user_id, user.id),
      })
    ).toHaveLength(1);
  });

  it('rejects a replay whose transaction belongs to another user', async () => {
    const owner = await insertTestUser();
    const otherUser = await insertTestUser();
    const storePurchase = purchase();
    await completeStoreCreditPurchase({ user: owner, purchase: storePurchase });

    await expect(
      completeStoreCreditPurchase({ user: otherUser, purchase: storePurchase })
    ).rejects.toThrow('Store transaction already belongs to another user');
    expect(await balanceOf(otherUser.id)).toBe(0);
  });

  it('rejects a replay with no matching credit transaction', async () => {
    const user = await insertTestUser();
    mockProcessTopUp.mockResolvedValueOnce(false);

    await expect(completeStoreCreditPurchase({ user, purchase: purchase() })).rejects.toThrow(
      'Failed to find the existing store credit transaction'
    );
  });

  it.each([NotificationTypeV2.REFUND, NotificationTypeV2.REVOKE])(
    'refuses to grant a credit pack the App Store already refunded with %s',
    async notificationType => {
      const user = await insertTestUser();
      const providerTransactionId = `tx-${crypto.randomUUID()}`;
      await insertRefundEvent({
        paymentProvider: KiloPassPaymentProvider.AppStore,
        notificationType,
        providerTransactionId,
        processed: true,
      });

      await expect(
        completeStoreCreditPurchase({
          user,
          purchase: purchase({ providerTransactionId }),
        })
      ).rejects.toThrow(STORE_PURCHASE_REFUNDED_MESSAGE);

      // The saved receipt is worthless: no credits, no balance change.
      expect(
        await creditRowsForPayment(
          storeCreditPaymentId(KiloPassPaymentProvider.AppStore, providerTransactionId)
        )
      ).toEqual([]);
      expect(await balanceOf(user.id)).toBe(0);
    }
  );

  it('grants a credit pack whose refund the store reversed before the grant', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: 1_777_700_000_000,
      processed: true,
    });
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      providerTransactionId,
      signedDate: 1_777_700_060_000,
      processed: true,
    });

    const result = await completeStoreCreditPurchase({
      user,
      purchase: purchase({ providerTransactionId }),
    });

    // The refund was reinstated, so the saved receipt is worth crediting.
    expect(result.alreadyProcessed).toBe(false);
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));
  });

  it('grants a credit pack when the reversal is delivered before the older refund it reverses', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    // The store signed the refund first and the reversal after it, but the
    // reversal reached Kilo first: the refund is the superseded delivery.
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      providerTransactionId,
      signedDate: 1_777_700_060_000,
      processed: true,
      processedAt: '2026-06-01T09:00:00.000Z',
    });
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: 1_777_700_000_000,
      processed: true,
      processedAt: '2026-06-01T09:00:01.000Z',
    });

    const result = await completeStoreCreditPurchase({
      user,
      purchase: purchase({ providerTransactionId }),
    });

    expect(result.alreadyProcessed).toBe(false);
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));
  });

  it('refuses a credit pack whose refund the store signed after the reversal', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      providerTransactionId,
      signedDate: 1_777_700_000_000,
      processed: true,
    });
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: 1_777_700_060_000,
      processed: true,
    });

    await expect(
      completeStoreCreditPurchase({ user, purchase: purchase({ providerTransactionId }) })
    ).rejects.toThrow(STORE_PURCHASE_REFUNDED_MESSAGE);
    expect(await balanceOf(user.id)).toBe(0);
  });

  it('keeps a refunded then reinstated pack credited when the receipt is replayed', async () => {
    const user = await insertTestUser();
    const storePurchase = purchase();
    const granted = await completeStoreCreditPurchase({ user, purchase: storePurchase });
    const paymentId = storeCreditPaymentId(
      storePurchase.paymentProvider,
      storePurchase.providerTransactionId
    );
    const storeTransaction = {
      paymentProvider: storePurchase.paymentProvider,
      providerTransactionIds: [storePurchase.providerTransactionId],
    };

    // The store refunds the granted pack, then reverses its own refund, exactly
    // as the App Store handler runs both notifications under the purchase lock.
    const refundEventId = await insertRefundEvent({
      paymentProvider: storePurchase.paymentProvider,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId: storePurchase.providerTransactionId,
      signedDate: 1_777_700_000_000,
      processed: false,
    });
    await db.transaction(async tx => {
      await lockStoreCreditPurchase(tx, storeTransaction);
      await reverseStoreCreditPurchase(tx, {
        ...storeTransaction,
        providerTransactionId: storePurchase.providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      });
      await tx
        .update(kilo_pass_store_events)
        .set({ processed_at: '2026-06-01T09:00:00.000Z' })
        .where(eq(kilo_pass_store_events.event_id, refundEventId));
    });
    expect(await balanceOf(user.id)).toBe(0);

    const reversalEventId = await insertRefundEvent({
      paymentProvider: storePurchase.paymentProvider,
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      providerTransactionId: storePurchase.providerTransactionId,
      signedDate: 1_777_700_060_000,
      processed: false,
    });
    await db.transaction(async tx => {
      await lockStoreCreditPurchase(tx, storeTransaction);
      await restoreStoreCreditPurchase(tx, {
        paymentProvider: storePurchase.paymentProvider,
        providerTransactionId: storePurchase.providerTransactionId,
      });
      await tx
        .update(kilo_pass_store_events)
        .set({ processed_at: '2026-06-01T09:00:01.000Z' })
        .where(eq(kilo_pass_store_events.event_id, reversalEventId));
    });
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));

    const replayed = await completeStoreCreditPurchase({ user, purchase: storePurchase });

    expect(replayed).toEqual({
      alreadyProcessed: true,
      amountUsd: 10,
      amountMicrodollars: toMicrodollars(10),
      creditTransactionId: granted.creditTransactionId,
    });
    expect(await creditRowsForPayment(paymentId)).toHaveLength(1);
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));
  });

  it('refuses to grant a Google Play credit pack refunded under the order id', async () => {
    const user = await insertTestUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      notificationType: 'voided_purchase',
      providerTransactionId: orderId,
      providerSubscriptionId: purchaseToken,
      processed: true,
    });

    await expect(
      completeStoreCreditPurchase({ user, purchase: playPurchase(orderId) })
    ).rejects.toThrow(STORE_PURCHASE_REFUNDED_MESSAGE);
    expect(await balanceOf(user.id)).toBe(0);
  });

  it('refuses a Google Play completion keyed by the purchase token the refund carries', async () => {
    const user = await insertTestUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      notificationType: 'voided_purchase',
      providerTransactionId: orderId,
      providerSubscriptionId: purchaseToken,
      processed: true,
    });

    // Play returned no order id when the client completed the purchase, so the
    // grant is keyed by the token digest while the refund notification names the
    // order id; the raw token carried on the purchase still finds the refund.
    const digestKeyed = playPurchase(googlePlayCreditProviderTransactionId({ purchaseToken }), {
      googlePlayPurchaseToken: purchaseToken,
    });
    await expect(completeStoreCreditPurchase({ user, purchase: digestKeyed })).rejects.toThrow(
      STORE_PURCHASE_REFUNDED_MESSAGE
    );
    expect(await balanceOf(user.id)).toBe(0);
  });

  it('grants a purchase whose refund event names another store transaction', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId: `tx-${crypto.randomUUID()}`,
      processed: true,
    });

    const result = await completeStoreCreditPurchase({
      user,
      purchase: purchase({ providerTransactionId }),
    });

    expect(result.alreadyProcessed).toBe(false);
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));
  });

  it('grants a purchase whose refund notification is still being processed', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      processed: false,
    });

    // A claimed but unprocessed event means the clawback has not happened yet, so
    // the grant stands and the refund that follows reverses it.
    const result = await completeStoreCreditPurchase({
      user,
      purchase: purchase({ providerTransactionId }),
    });

    expect(result.alreadyProcessed).toBe(false);
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));
  });

  it('does not refuse a refund recorded for another payment provider', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.Stripe,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      processed: true,
    });

    const result = await completeStoreCreditPurchase({
      user,
      purchase: purchase({ providerTransactionId }),
    });

    expect(result.alreadyProcessed).toBe(false);
    expect(await balanceOf(user.id)).toBe(toMicrodollars(10));
  });

  it('keeps a replay of an already granted, later refunded purchase idempotent', async () => {
    const user = await insertTestUser();
    const storePurchase = purchase();
    const paymentId = storeCreditPaymentId(
      storePurchase.paymentProvider,
      storePurchase.providerTransactionId
    );
    const granted = await completeStoreCreditPurchase({ user, purchase: storePurchase });

    // The store refunds the granted pack: the clawback is exactly once, and the
    // refund event is recorded as processed, exactly as the handler does.
    const eventId = await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId: storePurchase.providerTransactionId,
      processed: false,
    });
    await db.transaction(async tx => {
      await lockStoreCreditPurchase(tx, {
        paymentProvider: storePurchase.paymentProvider,
        providerTransactionIds: [storePurchase.providerTransactionId],
      });
      await reverseStoreCreditPurchase(tx, {
        paymentProvider: storePurchase.paymentProvider,
        providerTransactionId: storePurchase.providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      });
      await tx
        .update(kilo_pass_store_events)
        .set({ processed_at: new Date().toISOString() })
        .where(
          and(
            eq(kilo_pass_store_events.payment_provider, storePurchase.paymentProvider),
            eq(kilo_pass_store_events.event_id, eventId)
          )
        );
    });
    expect(await balanceOf(user.id)).toBe(0);

    const replayed = await completeStoreCreditPurchase({ user, purchase: storePurchase });

    expect(replayed).toEqual({
      alreadyProcessed: true,
      amountUsd: 10,
      amountMicrodollars: toMicrodollars(10),
      creditTransactionId: granted.creditTransactionId,
    });
    expect(await creditRowsForPayment(paymentId)).toHaveLength(1);
    expect(await balanceOf(user.id)).toBe(0);
  });

  it('refuses a completion that races the refund of the same purchase', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const eventId = await insertRefundEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      processed: false,
    });

    const lockHeld = Promise.withResolvers<number>();
    const refundMayFinish = Promise.withResolvers<void>();
    // The refund transaction as the App Store handler runs it: it records the
    // clawback and processes the event while holding the purchase's lock.
    const refund = db.transaction(async tx => {
      await lockStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
      });
      const {
        rows: [holder],
      } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      lockHeld.resolve(holder.pid);
      await refundMayFinish.promise;
      await reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      });
      await tx
        .update(kilo_pass_store_events)
        .set({ processed_at: new Date().toISOString() })
        .where(
          and(
            eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
            eq(kilo_pass_store_events.event_id, eventId)
          )
        );
    });

    const holderPid = await lockHeld.promise;

    let completionSettled = false;
    const completion = completeStoreCreditPurchase({
      user,
      purchase: purchase({ providerTransactionId }),
    }).then(
      result => {
        completionSettled = true;
        return result;
      },
      error => {
        completionSettled = true;
        throw error;
      }
    );

    // Release the transaction even if the ordering assertion fails.
    try {
      // Observe PostgreSQL's wait state instead of guessing a delay under CI load.
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !completionSettled; attempt += 1) {
        const waiting = await db.execute(sql`
          SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND ${holderPid} = ANY(pg_blocking_pids(pid))
        `);
        if (waiting.rows.length > 0) {
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
      expect(completionSettled).toBe(false);
    } finally {
      refundMayFinish.resolve();
    }
    await refund;

    await expect(completion).rejects.toThrow(STORE_PURCHASE_REFUNDED_MESSAGE);
    expect(
      await creditRowsForPayment(
        storeCreditPaymentId(KiloPassPaymentProvider.AppStore, providerTransactionId)
      )
    ).toEqual([]);
    expect(await balanceOf(user.id)).toBe(0);
  });
});

describe('reportStoreCreditPurchaseToBouncer', () => {
  it('reports a new production grant once, in US cents', async () => {
    const user = await insertTestUser();
    const storePurchase = purchase({ environment: 'Production' });
    const granted = await completeStoreCreditPurchase({ user, purchase: storePurchase });
    await reportStoreCreditPurchaseToBouncer({
      userId: user.id,
      purchase: storePurchase,
      result: granted,
    });
    const replayed = await completeStoreCreditPurchase({ user, purchase: storePurchase });
    await reportStoreCreditPurchaseToBouncer({
      userId: user.id,
      purchase: storePurchase,
      result: replayed,
    });

    expect(mockReportCreditEvent).toHaveBeenCalledTimes(1);
    expect(mockReportCreditEvent.mock.calls[0]?.[0]).toEqual({
      type: 'store.purchase',
      amountCents: 1000,
      provider: 'apple',
      eventId: storeCreditPaymentId(
        storePurchase.paymentProvider,
        storePurchase.providerTransactionId
      ),
      occurredAt: storePurchase.purchasedAtIso,
      userId: user.id,
      referenceId: storePurchase.providerTransactionId,
      environment: 'production',
    });
  });

  it('reports nothing for a sandbox grant', async () => {
    const user = await insertTestUser();
    const storePurchase = purchase({ environment: 'Sandbox' });
    const granted = await completeStoreCreditPurchase({ user, purchase: storePurchase });
    await reportStoreCreditPurchaseToBouncer({
      userId: user.id,
      purchase: storePurchase,
      result: granted,
    });

    expect(mockReportCreditEvent).not.toHaveBeenCalled();
  });
});
