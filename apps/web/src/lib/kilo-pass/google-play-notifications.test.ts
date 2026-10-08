import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { and, eq } from 'drizzle-orm';
import {
  bouncer_credit_event_outbox,
  credit_transactions,
  kilocode_users,
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { KiloPassPaymentProvider } from '@kilocode/web-shared/lib/kilo-pass/enums';
import type * as GooglePlayNotifications from './google-play-notifications';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { storeCreditPaymentId } from '@/lib/credits/store-products';
import { googlePlayCreditProviderTransactionId } from '@/lib/credits/store-verifier';
import { completeStoreCreditPurchase } from '@/lib/credits/store-completion';

const mockGetGooglePlayOrder =
  jest.fn<(orderId: string) => Promise<androidpublisher_v3.Schema$Order>>();
const mockGetGooglePlayProductPurchase = jest.fn(
  async (): Promise<androidpublisher_v3.Schema$ProductPurchase> => ({ purchaseType: undefined })
);
jest.mock('./google-play-sdk', () => ({
  getGooglePlayOrder: mockGetGooglePlayOrder,
  getGooglePlayProductPurchase: mockGetGooglePlayProductPurchase,
  GOOGLE_PLAY_PACKAGE_NAME: 'com.kilocode.kiloapp',
}));
let processGooglePlayKiloPassNotification: typeof GooglePlayNotifications.processGooglePlayKiloPassNotification;
// SWC static imports cannot see these SDK mocks; load the SUT after mock registration.
beforeAll(async () => {
  ({ processGooglePlayKiloPassNotification } = await import('./google-play-notifications'));
});
beforeEach(() => {
  mockGetGooglePlayOrder.mockReset();
  mockGetGooglePlayProductPurchase.mockReset().mockResolvedValue({ purchaseType: undefined });
});
const GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS = Date.parse('2026-05-15T00:00:00.000Z');
const STORE_PURCHASE_REFUNDED_MESSAGE =
  'This store purchase has been refunded, so Kilo cannot credit it.';
function pubsubMessage(
  params: {
    packageName?: string;
    notificationType?: number;
    purchaseToken?: string;
    eventTimeMillis?: string | number;
    messageId?: string;
    omitSubscriptionNotification?: boolean;
  } = {}
): GooglePlayNotifications.GooglePlayPubSubMessage {
  const notification: Record<string, unknown> = {
    version: '1.0',
    packageName: params.packageName ?? 'com.kilocode.kiloapp',
    eventTimeMillis: params.eventTimeMillis ?? String(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS),
  };
  if (!params.omitSubscriptionNotification) {
    notification.subscriptionNotification = {
      version: '1.0',
      notificationType: params.notificationType ?? 4,
      purchaseToken: params.purchaseToken ?? 'play-token-1',
      subscriptionId: 'kilopass_tier19',
    };
  }
  const data = Buffer.from(JSON.stringify(notification)).toString('base64');
  return {
    data,
    messageId: params.messageId,
  };
}
async function insertGooglePlayUser(): Promise<{
  user: User;
  obfsAccountId: string;
}> {
  const obfsAccountId = crypto.randomUUID();
  const user = await insertTestUser({ app_store_account_token: obfsAccountId });
  return { user, obfsAccountId };
}

describe('processGooglePlayKiloPassNotification', () => {
  async function assertIgnored(
    message: GooglePlayNotifications.GooglePlayPubSubMessage,
    purchaseToken: string
  ) {
    const transactionSpy = jest.spyOn(db, 'transaction');
    const insertSpy = jest.spyOn(db, 'insert');
    const updateSpy = jest.spyOn(db, 'update');
    const result = await processGooglePlayKiloPassNotification({ pubsubMessage: message });
    expect(result).toEqual({ processed: true });
    expect(transactionSpy).not.toHaveBeenCalled();
    transactionSpy.mockRestore();
    expect(insertSpy.mock.calls).toEqual([[kilo_pass_store_events]]);
    expect(updateSpy.mock.calls).toEqual([[kilo_pass_store_events]]);
    insertSpy.mockRestore();
    updateSpy.mockRestore();
    expect(mockGetGooglePlayOrder).not.toHaveBeenCalled();
    expect(mockGetGooglePlayProductPurchase).not.toHaveBeenCalled();
    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, message.messageId!),
    });
    expect(event?.processed_at).toBeTruthy();
    expect(event?.provider_subscription_id).toBe(purchaseToken);
    expect(
      await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.provider_subscription_id, purchaseToken),
      })
    ).toBeUndefined();
    expect(
      await db.query.kilo_pass_store_purchases.findFirst({
        where: eq(kilo_pass_store_purchases.purchase_token, purchaseToken),
      })
    ).toBeUndefined();
    expect(
      await db
        .select()
        .from(bouncer_credit_event_outbox)
        .where(eq(bouncer_credit_event_outbox.event_id, message.messageId!))
    ).toEqual([]);
    await expect(
      processGooglePlayKiloPassNotification({ pubsubMessage: message })
    ).resolves.toEqual({ processed: true, status: 'already_processed' });
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 999])(
    'ACKs subscription type %s with dedup only',
    async notificationType => {
      const purchaseToken = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      await assertIgnored(
        pubsubMessage({ notificationType, purchaseToken, messageId }),
        purchaseToken
      );
    }
  );

  it.each([1, 2, 999, undefined])(
    'ACKs voided subscriptions with refund type %s without refund side effects',
    async refundType => {
      const purchaseToken = crypto.randomUUID();
      await assertIgnored(
        {
          messageId: crypto.randomUUID(),
          data: Buffer.from(
            JSON.stringify({
              packageName: 'com.kilocode.kiloapp',
              voidedPurchaseNotification: {
                productType: 1,
                refundType,
                purchaseToken,
                orderId: crypto.randomUUID(),
              },
            })
          ).toString('base64'),
        },
        purchaseToken
      );
    }
  );

  it('ACKs one-time product notifications without adding subscription handling', async () => {
    const data = Buffer.from(
      JSON.stringify({
        packageName: 'com.kilocode.kiloapp',
        oneTimeProductNotification: {
          notificationType: 1,
          purchaseToken: crypto.randomUUID(),
          sku: 'credits_usd10',
        },
      })
    ).toString('base64');
    await expect(
      processGooglePlayKiloPassNotification({
        pubsubMessage: { data, messageId: crypto.randomUUID() },
      })
    ).resolves.toEqual({ processed: true });
    expect(mockGetGooglePlayOrder).not.toHaveBeenCalled();
    expect(mockGetGooglePlayProductPurchase).not.toHaveBeenCalled();
  });

  it('deduplicates a subscription delivery without a Pub/Sub message id', async () => {
    const purchaseToken = crypto.randomUUID();
    const message = pubsubMessage({ purchaseToken, notificationType: 2 });
    await expect(
      processGooglePlayKiloPassNotification({ pubsubMessage: message })
    ).resolves.toEqual({ processed: true });
    await expect(
      processGooglePlayKiloPassNotification({ pubsubMessage: message })
    ).resolves.toEqual({ processed: true, status: 'already_processed' });
    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(
        kilo_pass_store_events.event_id,
        `${purchaseToken}:2:${GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS}`
      ),
    });
    expect(event?.processed_at).toBeTruthy();
  });

  it('returns in_flight for a freshly claimed subscription delivery', async () => {
    const purchaseToken = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    await db.insert(kilo_pass_store_events).values({
      payment_provider: KiloPassPaymentProvider.GooglePlay,
      event_id: messageId,
      provider_subscription_id: purchaseToken,
      provider_transaction_id: '',
      product_id: 'kilopass_tier19',
      environment: 'unknown',
      payload_json: {},
      processing_started_at: new Date().toISOString(),
    });
    await expect(
      processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({ purchaseToken, messageId }),
      })
    ).resolves.toEqual({ processed: false, status: 'in_flight' });
    expect(mockGetGooglePlayOrder).not.toHaveBeenCalled();
  });

  it('rejects a package mismatch before recording a subscription delivery', async () => {
    await expect(
      processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({ packageName: 'wrong.package' }),
      })
    ).rejects.toThrow('Google Play notification package mismatch');
  });

  it('reverses a voided one-time credit pack order exactly once', async () => {
    const { user } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    const amountMicrodollars = toMicrodollars(50);
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: amountMicrodollars,
      is_free: false,
      description: 'Credit purchase via Google Play',
      stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, orderId),
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: amountMicrodollars })
      .where(eq(kilocode_users.id, user.id));

    const order = {
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd50' }],
    };
    mockGetGooglePlayOrder.mockResolvedValueOnce(order);
    const message = {
      messageId: crypto.randomUUID(),
      data: Buffer.from(
        JSON.stringify({
          packageName: 'com.kilocode.kiloapp',
          eventTimeMillis: String(Date.now()),
          voidedPurchaseNotification: {
            purchaseToken,
            orderId,
            productType: 2,
            refundType: 1,
          },
        })
      ).toString('base64'),
    };

    await expect(
      processGooglePlayKiloPassNotification({ pubsubMessage: message })
    ).resolves.toEqual({ processed: true });

    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after!.total_microdollars_acquired).toBe(0);

    const reversal = await db.query.credit_transactions.findFirst({
      where: eq(
        credit_transactions.credit_category,
        `store-credit-refund:${KiloPassPaymentProvider.GooglePlay}:${orderId}`
      ),
    });
    expect(reversal).toMatchObject({
      kilo_user_id: user.id,
      amount_microdollars: -amountMicrodollars,
      is_free: false,
    });

    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, message.messageId),
    });
    expect(event?.processed_at).not.toBeNull();

    // A replayed notification is already_processed and never reverses twice.
    mockGetGooglePlayOrder.mockResolvedValueOnce(order);
    await expect(
      processGooglePlayKiloPassNotification({ pubsubMessage: message })
    ).resolves.toEqual({ processed: true, status: 'already_processed' });
    const replayed = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(replayed!.total_microdollars_acquired).toBe(0);
  });

  it('refuses a late completion of a credit pack order refunded before the grant', async () => {
    const { user } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    mockGetGooglePlayOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd10' }],
    });
    const message = {
      messageId: crypto.randomUUID(),
      data: Buffer.from(
        JSON.stringify({
          packageName: 'com.kilocode.kiloapp',
          eventTimeMillis: String(Date.now()),
          voidedPurchaseNotification: {
            purchaseToken,
            orderId,
            productType: 2,
            refundType: 1,
          },
        })
      ).toString('base64'),
    };

    // The refund arrives before the client finishes the purchase: there is
    // nothing to claw back, but the voided purchase is recorded as processed.
    await expect(
      processGooglePlayKiloPassNotification({ pubsubMessage: message })
    ).resolves.toEqual({ processed: true });

    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, message.messageId),
    });
    expect(event?.processed_at).not.toBeNull();
    expect(
      await db.query.credit_transactions.findFirst({
        where: eq(
          credit_transactions.credit_category,
          `store-credit-refund:${KiloPassPaymentProvider.GooglePlay}:${orderId}`
        ),
      })
    ).toBeUndefined();

    // A grant keyed by the order id and one keyed by the token digest are both
    // refused. Play reported no order id when the purchase completed, so the
    // grant may hold the digest while the voided notification names the order
    // id; the refund lookup matches the raw token the store-event table stores,
    // which never becomes the ledger key.
    const tokenKey = googlePlayCreditProviderTransactionId({ purchaseToken });
    for (const grant of [
      { providerTransactionId: orderId, googlePlayPurchaseToken: purchaseToken },
      { providerTransactionId: tokenKey, googlePlayPurchaseToken: purchaseToken },
    ]) {
      await expect(
        completeStoreCreditPurchase({
          user,
          purchase: {
            paymentProvider: KiloPassPaymentProvider.GooglePlay,
            productId: 'credits_usd10',
            appAccountToken: user.app_store_account_token,
            quantity: 1,
            amountUsd: 10,
            amountMicrodollars: toMicrodollars(10),
            purchasedAtIso: '2026-05-15T00:00:00.000Z',
            environment: 'Production',
            rawPayload: {},
            ...grant,
          },
        })
      ).rejects.toThrow(STORE_PURCHASE_REFUNDED_MESSAGE);
    }

    expect(
      await db.query.credit_transactions.findFirst({
        where: eq(
          credit_transactions.stripe_payment_id,
          storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, tokenKey)
        ),
      })
    ).toBeUndefined();
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after?.total_microdollars_acquired).toBe(0);
  });

  describe('voided credit pack refund types', () => {
    async function grantGooglePlayCreditPack() {
      const { user } = await insertGooglePlayUser();
      const orderId = `GPA.${crypto.randomUUID()}`;
      const purchaseToken = crypto.randomUUID();
      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        amount_microdollars: toMicrodollars(10),
        is_free: false,
        description: 'Credit purchase via Google Play',
        stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, orderId),
      });
      await db
        .update(kilocode_users)
        .set({ total_microdollars_acquired: toMicrodollars(10), microdollars_used: 0 })
        .where(eq(kilocode_users.id, user.id));
      return { user, orderId, purchaseToken };
    }

    function voidedMessage(params: { orderId: string; purchaseToken: string; refundType: number }) {
      return {
        messageId: crypto.randomUUID(),
        data: Buffer.from(
          JSON.stringify({
            packageName: 'com.kilocode.kiloapp',
            eventTimeMillis: String(Date.now()),
            voidedPurchaseNotification: {
              purchaseToken: params.purchaseToken,
              orderId: params.orderId,
              productType: 2,
              refundType: params.refundType,
            },
          })
        ).toString('base64'),
      };
    }

    async function reversalAmounts(orderId: string) {
      const rows = await db
        .select()
        .from(credit_transactions)
        .where(
          eq(
            credit_transactions.credit_category,
            `store-credit-refund:${KiloPassPaymentProvider.GooglePlay}:${orderId}`
          )
        );
      return rows.map(row => row.amount_microdollars);
    }

    it('reverses the whole pack for a quantity-based refund of a single unit', async () => {
      const { orderId, purchaseToken } = await grantGooglePlayCreditPack();
      mockGetGooglePlayOrder.mockResolvedValueOnce({
        orderId,
        purchaseToken,
        state: 'REFUNDED',
        lineItems: [{ productId: 'credits_usd10', oneTimePurchaseDetails: { quantity: 1 } }],
      });

      await expect(
        processGooglePlayKiloPassNotification({
          pubsubMessage: voidedMessage({ orderId, purchaseToken, refundType: 2 }),
        })
      ).resolves.toEqual({ processed: true });

      expect(await reversalAmounts(orderId)).toEqual([-toMicrodollars(10)]);
    });

    // Play keeps PARTIALLY_REFUNDED for a quantity-based refund, which is the whole
    // pack when the line item holds one unit.
    it('reverses the whole pack when Play reports PARTIALLY_REFUNDED for one unit', async () => {
      const { orderId, purchaseToken } = await grantGooglePlayCreditPack();
      mockGetGooglePlayOrder.mockResolvedValueOnce({
        orderId,
        purchaseToken,
        state: 'PARTIALLY_REFUNDED',
        lineItems: [{ productId: 'credits_usd10', oneTimePurchaseDetails: { quantity: 1 } }],
      });

      await expect(
        processGooglePlayKiloPassNotification({
          pubsubMessage: voidedMessage({ orderId, purchaseToken, refundType: 2 }),
        })
      ).resolves.toEqual({ processed: true });

      expect(await reversalAmounts(orderId)).toEqual([-toMicrodollars(10)]);
    });

    it('rejects a quantity-based refund of a multi-quantity pack without reversing', async () => {
      const { user, orderId, purchaseToken } = await grantGooglePlayCreditPack();
      mockGetGooglePlayOrder.mockResolvedValueOnce({
        orderId,
        purchaseToken,
        state: 'PARTIALLY_REFUNDED',
        lineItems: [{ productId: 'credits_usd10', oneTimePurchaseDetails: { quantity: 3 } }],
      });

      await expect(
        processGooglePlayKiloPassNotification({
          pubsubMessage: voidedMessage({ orderId, purchaseToken, refundType: 2 }),
        })
      ).rejects.toThrow('Google Play multi-quantity credit pack refund is not supported');

      expect(await reversalAmounts(orderId)).toEqual([]);
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after!.total_microdollars_acquired).toBe(toMicrodollars(10));
    });

    it('keeps one full reversal when Play resends the refund under a new message after more spend', async () => {
      const { user, orderId, purchaseToken } = await grantGooglePlayCreditPack();
      const order = {
        orderId,
        purchaseToken,
        state: 'REFUNDED',
        lineItems: [{ productId: 'credits_usd10' }],
      };
      mockGetGooglePlayOrder.mockResolvedValueOnce(order);
      await processGooglePlayKiloPassNotification({
        pubsubMessage: voidedMessage({ orderId, purchaseToken, refundType: 1 }),
      });
      await db
        .update(kilocode_users)
        .set({ microdollars_used: toMicrodollars(4) })
        .where(eq(kilocode_users.id, user.id));

      // A new message id bypasses the event claim, so only the reversal's own
      // idempotency key protects the stored amount.
      mockGetGooglePlayOrder.mockResolvedValueOnce(order);
      await expect(
        processGooglePlayKiloPassNotification({
          pubsubMessage: voidedMessage({ orderId, purchaseToken, refundType: 1 }),
        })
      ).resolves.toEqual({ processed: true });

      expect(await reversalAmounts(orderId)).toEqual([-toMicrodollars(10)]);
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after!.total_microdollars_acquired).toBe(0);
    });
  });

  it('reverses a voided one-time credit pack granted under the purchase token', async () => {
    const { user } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    const tokenKey = googlePlayCreditProviderTransactionId({ purchaseToken });
    const amountMicrodollars = toMicrodollars(10);
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: amountMicrodollars,
      is_free: false,
      description: 'Credit purchase via Google Play',
      // Play reported no order id when the purchase completed, so the grant is
      // keyed by a digest of the purchase token — never the token itself —
      // while the voided notification still carries an order id.
      stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, tokenKey),
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: amountMicrodollars })
      .where(eq(kilocode_users.id, user.id));

    mockGetGooglePlayOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd10' }],
    });

    await expect(
      processGooglePlayKiloPassNotification({
        pubsubMessage: {
          messageId: crypto.randomUUID(),
          data: Buffer.from(
            JSON.stringify({
              packageName: 'com.kilocode.kiloapp',
              eventTimeMillis: String(Date.now()),
              voidedPurchaseNotification: {
                purchaseToken,
                orderId,
                productType: 2,
                refundType: 1,
              },
            })
          ).toString('base64'),
        },
      })
    ).resolves.toEqual({ processed: true });

    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after!.total_microdollars_acquired).toBe(0);

    const reversal = await db.query.credit_transactions.findFirst({
      where: eq(
        credit_transactions.credit_category,
        `store-credit-refund:${KiloPassPaymentProvider.GooglePlay}:${tokenKey}`
      ),
    });
    expect(reversal).toMatchObject({
      kilo_user_id: user.id,
      amount_microdollars: -amountMicrodollars,
      is_free: false,
    });
  });

  it('rejects a voided one-time credit pack order that is not refunded', async () => {
    const { user } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    mockGetGooglePlayOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'PROCESSED',
      lineItems: [{ productId: 'credits_usd50' }],
    });

    await expect(
      processGooglePlayKiloPassNotification({
        pubsubMessage: {
          messageId: crypto.randomUUID(),
          data: Buffer.from(
            JSON.stringify({
              packageName: 'com.kilocode.kiloapp',
              voidedPurchaseNotification: {
                purchaseToken,
                orderId,
                productType: 2,
                refundType: 1,
              },
            })
          ).toString('base64'),
        },
      })
    ).rejects.toThrow('Google Play refund does not match');

    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after!.total_microdollars_acquired).toBe(user.total_microdollars_acquired);
  });
});

describe('Google Play bouncer store events', () => {
  /** The durable outbox row one event produced, or null when nothing was enqueued. */
  async function outboxRowFor(eventId: string) {
    const rows = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, eventId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Whether a store event is marked processed. Every enqueue commits in the same transaction as
   * the processed mark, so both are present after one notification.
   */
  async function storeEventProcessed(eventId: string): Promise<boolean> {
    const row = await db.query.kilo_pass_store_events.findFirst({
      where: and(
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_events.event_id, eventId)
      ),
      columns: { processed_at: true },
    });
    return Boolean(row?.processed_at);
  }
  function voidedCreditPackMessage(messageId: string, purchaseToken: string, orderId: string) {
    return {
      messageId,
      data: Buffer.from(
        JSON.stringify({
          packageName: 'com.kilocode.kiloapp',
          eventTimeMillis: String(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS),
          voidedPurchaseNotification: { purchaseToken, orderId, productType: 2, refundType: 1 },
        })
      ).toString('base64'),
    };
  }

  it('reports a refunded credit pack for the pack owner', async () => {
    const { user } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: toMicrodollars(10),
      is_free: false,
      description: 'Credit purchase via Google Play',
      stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, orderId),
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: toMicrodollars(10) })
      .where(eq(kilocode_users.id, user.id));
    mockGetGooglePlayOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd10' }],
    });

    await processGooglePlayKiloPassNotification({
      pubsubMessage: voidedCreditPackMessage('credit-pack-void', purchaseToken, orderId),
    });

    const row = await outboxRowFor('credit-pack-void');
    expect(row).toMatchObject({ event_type: 'store.refund', user_id: user.id });
    expect(row?.payload).toEqual({
      eventId: 'credit-pack-void',
      occurredAt: '2026-05-15T00:00:00.000Z',
      userId: user.id,
      provider: 'google',
      referenceId: orderId,
      environment: 'production',
      type: 'store.refund',
      reason: 'other',
    });
    expect(await storeEventProcessed('credit-pack-void')).toBe(true);
  });

  it('reports nothing for a refunded license-tester credit pack', async () => {
    const { user } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: toMicrodollars(10),
      is_free: false,
      description: 'Credit purchase via Google Play',
      stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, orderId),
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: toMicrodollars(10) })
      .where(eq(kilocode_users.id, user.id));
    mockGetGooglePlayOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd10' }],
    });
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce({ purchaseType: 0 });

    await processGooglePlayKiloPassNotification({
      pubsubMessage: voidedCreditPackMessage('credit-pack-void-tester', purchaseToken, orderId),
    });

    const clawback = await db.query.credit_transactions.findFirst({
      where: eq(
        credit_transactions.credit_category,
        `store-credit-refund:${KiloPassPaymentProvider.GooglePlay}:${orderId}`
      ),
    });
    expect(clawback?.amount_microdollars).toBe(-toMicrodollars(10));
    expect(await outboxRowFor('credit-pack-void-tester')).toBeNull();
  });

  it('still reports a credit-pack refund when the purchase lookup fails', async () => {
    const { user } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: toMicrodollars(10),
      is_free: false,
      description: 'Credit purchase via Google Play',
      stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, orderId),
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: toMicrodollars(10) })
      .where(eq(kilocode_users.id, user.id));
    mockGetGooglePlayOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd10' }],
    });
    mockGetGooglePlayProductPurchase.mockRejectedValueOnce(new Error('404 purchase not found'));

    await processGooglePlayKiloPassNotification({
      pubsubMessage: voidedCreditPackMessage(
        'credit-pack-void-lookup-fail',
        purchaseToken,
        orderId
      ),
    });

    const row = await outboxRowFor('credit-pack-void-lookup-fail');
    expect(row).toMatchObject({ event_type: 'store.refund', user_id: user.id });
    expect(row?.payload).toMatchObject({
      type: 'store.refund',
      userId: user.id,
      referenceId: orderId,
      environment: 'production',
    });
  });

  it('reports nothing for a refunded credit pack Kilo never granted', async () => {
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    mockGetGooglePlayOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd10' }],
    });

    await processGooglePlayKiloPassNotification({
      pubsubMessage: voidedCreditPackMessage('credit-pack-void-ungranted', purchaseToken, orderId),
    });

    expect(await outboxRowFor('credit-pack-void-ungranted')).toBeNull();
  });
});
