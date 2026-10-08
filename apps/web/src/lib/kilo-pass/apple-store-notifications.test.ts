import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  DeliveryStatus,
  NotificationTypeV2,
  RefundPreference,
  RevocationType,
  Subtype,
} from '@apple/app-store-server-library';
import { eq } from 'drizzle-orm';

import {
  bouncer_credit_event_outbox,
  credit_transactions,
  kilocode_users,
  kilo_pass_audit_log,
  kilo_pass_store_events,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  KiloPassAuditLogAction,
  KiloPassCadence,
  KiloPassPaymentProvider,
  KiloPassTier,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import type * as AppleStoreNotifications from './apple-store-notifications';
import type { AppleStoreDecodedNotification } from './apple-store-notifications';
import type { AppleStoreDecodedTransaction } from './apple-store-sdk';
import type * as StoreRefund from '@/lib/credits/store-refund';
import type * as CreditEventsModule from '@kilocode/web-shared/lib/bouncer/credit-events';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { storeCreditPaymentId } from '@/lib/credits/store-products';
import { completeStoreCreditPurchase } from '@/lib/credits/store-completion';

// SWC + static ESM imports do not see jest.mock replacements on the same module id.
// Dynamic-import the SUT after the mock (same pattern as stripe-handlers-invoice-paid.test.ts).

// The real enqueue writes a real `bouncer_credit_event_outbox` row, so the bouncer tests assert
// that durable row. One test overrides the enqueue to reject, proving it shares the notification's
// transaction: a failed enqueue must roll back `processed_at`.
jest.mock('@kilocode/web-shared/lib/bouncer/credit-events', () => {
  const actual = jest.requireActual<typeof CreditEventsModule>(
    '@kilocode/web-shared/lib/bouncer/credit-events'
  );
  return {
    __esModule: true,
    ...actual,
    enqueueCreditEvent: jest.fn(actual.enqueueCreditEvent),
  };
});

function getEnqueueCreditEventMock() {
  return jest.mocked(
    (
      jest.requireMock(
        '@kilocode/web-shared/lib/bouncer/credit-events'
      ) as typeof CreditEventsModule
    ).enqueueCreditEvent
  );
}

// The real reversal runs against the test database by default; one test makes a
// single call fail to prove a failed credit-pack clawback is not swallowed.
jest.mock('@/lib/credits/store-refund', () => {
  const actual = jest.requireActual<typeof StoreRefund>('@/lib/credits/store-refund');
  return {
    __esModule: true,
    ...actual,
    reverseStoreCreditPurchase: jest.fn(actual.reverseStoreCreditPurchase),
  };
});

function getStoreRefundMock(): typeof StoreRefund {
  return jest.requireMock<typeof StoreRefund>('@/lib/credits/store-refund');
}

const mockReverseStoreCreditPurchase = jest.mocked(getStoreRefundMock().reverseStoreCreditPurchase);

let processAppStoreKiloPassNotification: typeof AppleStoreNotifications.processAppStoreKiloPassNotification;

const APP_STORE_NOTIFICATION_TEST_NOW_MS = Date.parse('2026-05-15T00:00:00.000Z');
// The store's own chronology, which orders deliveries that arrive out of order.
const REFUND_SIGNED_AT_MS = APP_STORE_NOTIFICATION_TEST_NOW_MS;
const REFUND_REVERSED_SIGNED_AT_MS = APP_STORE_NOTIFICATION_TEST_NOW_MS + 60_000;

/** A granted credit pack, exactly as `completeStoreCreditPurchase` writes it. */
async function insertGrantedCreditPack(params: {
  userId: string;
  transactionId: string;
  amountMicrodollars: number;
}): Promise<void> {
  await db.insert(credit_transactions).values({
    kilo_user_id: params.userId,
    amount_microdollars: params.amountMicrodollars,
    is_free: false,
    description: 'Credit purchase via App Store',
    stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.AppStore, params.transactionId),
  });
  await db
    .update(kilocode_users)
    .set({ total_microdollars_acquired: params.amountMicrodollars })
    .where(eq(kilocode_users.id, params.userId));
}

function creditRowsForCategory(creditCategory: string) {
  return db
    .select({
      id: credit_transactions.id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      creditCategory: credit_transactions.credit_category,
    })
    .from(credit_transactions)
    .where(eq(credit_transactions.credit_category, creditCategory));
}

// The mobile clients match this exact backend string, so it is pinned here
// rather than imported from the constant the completion throws it from.
const STORE_PURCHASE_REFUNDED_MESSAGE =
  'This store purchase has been refunded, so Kilo cannot credit it.';

function notification(
  overrides: Partial<AppleStoreDecodedNotification> = {}
): AppleStoreDecodedNotification {
  return {
    notificationUUID: `note-${crypto.randomUUID()}`,
    notificationType: NotificationTypeV2.DID_RENEW,
    environment: 'Sandbox',
    signedTransactionInfo: 'signed-transaction',
    ...overrides,
  };
}

function transaction(
  overrides: Partial<AppleStoreDecodedTransaction> = {}
): AppleStoreDecodedTransaction {
  return {
    transactionId: `tx-${crypto.randomUUID()}`,
    originalTransactionId: `orig-${crypto.randomUUID()}`,
    bundleId: 'com.kilocode.kiloapp',
    productId: 'kilopass.tier19.monthly.v1',
    purchaseDate: 1_777_626_000_000,
    expiresDate: Date.parse('2030-06-01T00:00:00.000Z'),
    environment: 'Sandbox',
    rawPayload: { test: true },
    ...overrides,
  };
}

async function insertProviderScopedSubscriptionRows(providerSubscriptionId: string) {
  const stripeUser = await insertTestUser();
  const appStoreUser = await insertTestUser();
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;

  await db.insert(kilo_pass_subscriptions).values({
    kilo_user_id: stripeUser.id,
    payment_provider: KiloPassPaymentProvider.Stripe,
    provider_subscription_id: stripeSubscriptionId,
    stripe_subscription_id: stripeSubscriptionId,
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
    status: 'active',
    cancel_at_period_end: false,
    started_at: '2026-05-01T00:00:00.000Z',
    ended_at: null,
  });

  await db.insert(kilo_pass_subscriptions).values({
    kilo_user_id: appStoreUser.id,
    payment_provider: KiloPassPaymentProvider.AppStore,
    provider_subscription_id: providerSubscriptionId,
    stripe_subscription_id: null,
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
    status: 'active',
    cancel_at_period_end: false,
    started_at: '2026-05-01T00:00:00.000Z',
    ended_at: null,
  });

  return { stripeUser, appStoreUser, stripeSubscriptionId };
}

describe('processAppStoreKiloPassNotification', () => {
  let dateNowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeAll(async () => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(APP_STORE_NOTIFICATION_TEST_NOW_MS);
    ({ processAppStoreKiloPassNotification } = await import('./apple-store-notifications'));
  });

  afterAll(() => {
    dateNowSpy.mockRestore();
  });

  beforeEach(() => {
    mockReverseStoreCreditPurchase.mockClear();
  });

  it.each([
    ...Object.values(NotificationTypeV2).map(notificationType => ({
      notificationType,
      subtype: undefined,
    })),
    { notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_PREF, subtype: Subtype.UPGRADE },
    { notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_PREF, subtype: Subtype.DOWNGRADE },
    {
      notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
      subtype: Subtype.AUTO_RENEW_DISABLED,
    },
    {
      notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
      subtype: Subtype.AUTO_RENEW_ENABLED,
    },
  ])(
    'acknowledges and ignores subscription $notificationType/$subtype',
    async ({ notificationType, subtype }) => {
      const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
      const { appStoreUser } = await insertProviderScopedSubscriptionRows(providerSubscriptionId);
      const decodedNotification = notification({
        notificationType,
        subtype,
        environment: 'Production',
      });
      const decodedTransaction = transaction({
        originalTransactionId: providerSubscriptionId,
        appAccountToken: appStoreUser.app_store_account_token,
        expiresDate: Date.now() - 1,
        revocationDate: Date.now(),
      });
      const sendConsumptionInformation = jest.fn<() => Promise<void>>();
      const subscriptionsBefore = await db.query.kilo_pass_subscriptions.findMany();
      const purchasesBefore = await db.query.kilo_pass_store_purchases.findMany();
      const issuancesBefore = await db.query.kilo_pass_issuances.findMany();
      const itemsBefore = await db.query.kilo_pass_issuance_items.findMany();
      const creditsBefore = await db.query.credit_transactions.findMany();
      const usersBefore = await db.query.kilocode_users.findMany();
      const auditBefore = await db.query.kilo_pass_audit_log.findMany();
      const outboxBefore = await db.query.bouncer_credit_event_outbox.findMany();
      getEnqueueCreditEventMock().mockClear();
      const params = {
        signedPayload: 'subscription',
        decodeNotification: async () => decodedNotification,
        decodeTransaction: async () => decodedTransaction,
        sendConsumptionInformation,
      };
      await expect(processAppStoreKiloPassNotification(params)).resolves.toEqual({
        processed: true,
      });
      await expect(processAppStoreKiloPassNotification(params)).resolves.toEqual({
        processed: true,
        status: 'already_processed',
      });
      const events = await db.query.kilo_pass_store_events.findMany({
        where: eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID),
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        product_id: decodedTransaction.productId,
        provider_subscription_id: providerSubscriptionId,
        provider_transaction_id: decodedTransaction.transactionId,
        processed_at: expect.any(String),
        payload_json: { notificationType, subtype: subtype ?? null },
      });
      expect(await db.query.kilo_pass_subscriptions.findMany()).toEqual(subscriptionsBefore);
      expect(await db.query.kilo_pass_store_purchases.findMany()).toEqual(purchasesBefore);
      expect(await db.query.kilo_pass_issuances.findMany()).toEqual(issuancesBefore);
      expect(await db.query.kilo_pass_issuance_items.findMany()).toEqual(itemsBefore);
      expect(await db.query.credit_transactions.findMany()).toEqual(creditsBefore);
      expect(await db.query.kilocode_users.findMany()).toEqual(usersBefore);
      expect(await db.query.kilo_pass_audit_log.findMany()).toEqual(auditBefore);
      expect(await db.query.bouncer_credit_event_outbox.findMany()).toEqual(outboxBefore);
      expect(sendConsumptionInformation).not.toHaveBeenCalled();
      expect(mockReverseStoreCreditPurchase).not.toHaveBeenCalled();
      expect(getEnqueueCreditEventMock()).not.toHaveBeenCalled();
    }
  );

  it('does not process concurrent duplicate notification deliveries twice', async () => {
    const decodedNotification = notification({
      notificationUUID: 'concurrent-consumption-request',
      notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
    });
    const decodedTransaction = transaction({ productId: 'credits.usd10.v1' });
    const consumptionInformationStarted = Promise.withResolvers<void>();
    const releaseConsumptionInformation = Promise.withResolvers<void>();
    const sendConsumptionInformation = jest.fn(async () => {
      consumptionInformationStarted.resolve();
      await releaseConsumptionInformation.promise;
    });
    const params = {
      signedPayload: 'concurrent-consumption-request',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
      sendConsumptionInformation,
    };

    const firstDelivery = processAppStoreKiloPassNotification(params);
    await consumptionInformationStarted.promise;

    const duplicateResult = await processAppStoreKiloPassNotification(params);

    releaseConsumptionInformation.resolve();
    const firstResult = await firstDelivery;
    const results = [firstResult, duplicateResult];

    expect(results.filter(result => result.processed)).toHaveLength(1);
    expect(results).toContainEqual({ processed: false, status: 'in_flight' });
    expect(sendConsumptionInformation).toHaveBeenCalledTimes(1);
  });

  it('retries a stale unprocessed notification claim', async () => {
    const decodedNotification = notification({
      notificationUUID: 'stale-consumption-request',
      notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
    });
    const decodedTransaction = transaction({ productId: 'credits.usd10.v1' });
    await db.insert(kilo_pass_store_events).values({
      payment_provider: KiloPassPaymentProvider.AppStore,
      event_id: decodedNotification.notificationUUID,
      provider_subscription_id: decodedTransaction.originalTransactionId,
      provider_transaction_id: decodedTransaction.transactionId,
      product_id: decodedTransaction.productId,
      environment: 'Sandbox',
      payload_json: {
        notificationType: decodedNotification.notificationType,
      },
      processing_started_at: '2026-01-01T00:00:00.000Z',
      processed_at: null,
    });

    const sendConsumptionInformation = jest.fn(async () => {});
    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'stale-consumption-request',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
      sendConsumptionInformation,
    });

    expect(result).toEqual({ processed: true });
    expect(sendConsumptionInformation).toHaveBeenCalledTimes(1);

    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID),
    });
    expect(event?.processed_at).not.toBeNull();
    expect(new Date(event?.processing_started_at ?? '').getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00.000Z').getTime()
    );
  });
  it('reverses the whole store credit pack on a full refund and still records the event', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const transactionId = `tx-${crypto.randomUUID()}`;
    const amountMicrodollars = toMicrodollars(10);
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: amountMicrodollars,
      is_free: false,
      description: 'Credit purchase via App Store',
      stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.AppStore, transactionId),
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: amountMicrodollars })
      .where(eq(kilocode_users.id, user.id));

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'credit-pack-refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'credit-pack-refund',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'credit-pack-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          transactionId,
          productId: 'credits.usd10.v1',
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-16T00:00:00.000Z'),
          revocationType: RevocationType.REFUND_FULL,
          revocationPercentage: 100_000,
        }),
    });

    expect(result).toEqual({ processed: true });

    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after?.total_microdollars_acquired).toBe(0);

    const reversal = await db.query.credit_transactions.findFirst({
      where: eq(
        credit_transactions.credit_category,
        `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
      ),
    });
    expect(reversal).toMatchObject({
      kilo_user_id: user.id,
      amount_microdollars: -amountMicrodollars,
      is_free: false,
    });

    // The refund is recorded as a processed store event, so replay cannot
    // reverse the pack twice.
    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'credit-pack-refund'),
    });
    expect(event?.processed_at).not.toBeNull();

    const audit = await db.query.kilo_pass_audit_log.findFirst({
      where: sql`${kilo_pass_audit_log.payload_json}->>'notificationUUID' = 'credit-pack-refund'`,
    });
    expect(audit?.payload_json).toMatchObject({
      notificationUUID: 'credit-pack-refund',
      providerTransactionId: transactionId,
      storeCreditReversal: { reversed: true, amountMicrodollars },
    });
  });

  describe('reversed refunds', () => {
    async function refund(params: {
      transactionId: string;
      signedDate: number;
      notificationUUID: string;
    }) {
      return processAppStoreKiloPassNotification({
        signedPayload: params.notificationUUID,
        decodeNotification: async () =>
          notification({
            notificationUUID: params.notificationUUID,
            notificationType: NotificationTypeV2.REFUND,
            signedDate: params.signedDate,
            signedTransactionInfo: `${params.notificationUUID}-transaction`,
          }),
        decodeTransaction: async () =>
          transaction({
            transactionId: params.transactionId,
            productId: 'credits.usd10.v1',
            revocationDate: params.signedDate,
            revocationType: RevocationType.REFUND_FULL,
            revocationPercentage: 100_000,
          }),
      });
    }

    async function refundReversed(params: {
      transactionId: string;
      signedDate: number;
      notificationUUID: string;
    }) {
      return processAppStoreKiloPassNotification({
        signedPayload: params.notificationUUID,
        decodeNotification: async () =>
          notification({
            notificationUUID: params.notificationUUID,
            notificationType: NotificationTypeV2.REFUND_REVERSED,
            signedDate: params.signedDate,
            signedTransactionInfo: `${params.notificationUUID}-transaction`,
          }),
        decodeTransaction: async () =>
          transaction({
            transactionId: params.transactionId,
            productId: 'credits.usd10.v1',
            revocationDate: params.signedDate,
          }),
      });
    }

    async function acquiredMicrodollars(userId: string): Promise<number> {
      const user = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, userId),
      });
      return user?.total_microdollars_acquired ?? 0;
    }

    it('restores the credits a refund clawed back exactly once', async () => {
      const user = await insertTestUser({ total_microdollars_acquired: 0 });
      const transactionId = `tx-${crypto.randomUUID()}`;
      const amountMicrodollars = toMicrodollars(10);
      await insertGrantedCreditPack({ userId: user.id, transactionId, amountMicrodollars });

      await expect(
        refund({
          transactionId,
          signedDate: REFUND_SIGNED_AT_MS,
          notificationUUID: 'credit-pack-reversed-refund',
        })
      ).resolves.toEqual({ processed: true });
      expect(await acquiredMicrodollars(user.id)).toBe(0);

      await expect(
        refundReversed({
          transactionId,
          signedDate: REFUND_REVERSED_SIGNED_AT_MS,
          notificationUUID: 'credit-pack-refund-reversed',
        })
      ).resolves.toEqual({ processed: true });

      expect(await acquiredMicrodollars(user.id)).toBe(amountMicrodollars);
      const restorations = await creditRowsForCategory(
        `store-credit-refund-reversal:${KiloPassPaymentProvider.AppStore}:${transactionId}`
      );
      expect(restorations).toEqual([
        {
          id: expect.any(String),
          amountMicrodollars,
          creditCategory: `store-credit-refund-reversal:${KiloPassPaymentProvider.AppStore}:${transactionId}`,
        },
      ]);

      // Apple redelivers the reversal with a fresh notification id: the restore
      // is keyed by the purchase, so it cannot credit the pack twice.
      await expect(
        refundReversed({
          transactionId,
          signedDate: REFUND_REVERSED_SIGNED_AT_MS,
          notificationUUID: 'credit-pack-refund-reversed-again',
        })
      ).resolves.toEqual({ processed: true });

      expect(await acquiredMicrodollars(user.id)).toBe(amountMicrodollars);
      expect(
        await creditRowsForCategory(
          `store-credit-refund-reversal:${KiloPassPaymentProvider.AppStore}:${transactionId}`
        )
      ).toHaveLength(1);
    });

    it('leaves the pack credited when a reversal arrives before the older refund it reverses', async () => {
      const user = await insertTestUser({ total_microdollars_acquired: 0 });
      const transactionId = `tx-${crypto.randomUUID()}`;
      const amountMicrodollars = toMicrodollars(10);
      await insertGrantedCreditPack({ userId: user.id, transactionId, amountMicrodollars });

      // The reversal reaches Kilo first, and the refund it reverses was signed
      // before it: the refund is superseded and must not claw the pack back.
      await expect(
        refundReversed({
          transactionId,
          signedDate: REFUND_REVERSED_SIGNED_AT_MS,
          notificationUUID: 'credit-pack-reversal-before-refund',
        })
      ).resolves.toEqual({ processed: true });
      await expect(
        refund({
          transactionId,
          signedDate: REFUND_SIGNED_AT_MS,
          notificationUUID: 'credit-pack-stale-refund',
        })
      ).resolves.toEqual({ processed: true });

      expect(await acquiredMicrodollars(user.id)).toBe(amountMicrodollars);
      expect(
        await creditRowsForCategory(
          `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
        )
      ).toEqual([]);
      const staleAudit = await db.query.kilo_pass_audit_log.findFirst({
        where: sql`${kilo_pass_audit_log.payload_json}->>'notificationUUID' = 'credit-pack-stale-refund'`,
      });
      expect(staleAudit?.action).toBe(KiloPassAuditLogAction.StoreNotificationReceived);
      expect(staleAudit?.payload_json).toMatchObject({
        supersededByStoreReversal: true,
        storeCreditReversal: null,
      });
    });

    it('claws the pack back when the refund is signed after the reversal Kilo processed', async () => {
      const user = await insertTestUser({ total_microdollars_acquired: 0 });
      const transactionId = `tx-${crypto.randomUUID()}`;
      const amountMicrodollars = toMicrodollars(10);
      await insertGrantedCreditPack({ userId: user.id, transactionId, amountMicrodollars });

      // The store reversed an earlier refund, and then refunded the pack again.
      await expect(
        refundReversed({
          transactionId,
          signedDate: REFUND_SIGNED_AT_MS,
          notificationUUID: 'credit-pack-earlier-reversal',
        })
      ).resolves.toEqual({ processed: true });
      await expect(
        refund({
          transactionId,
          signedDate: REFUND_REVERSED_SIGNED_AT_MS,
          notificationUUID: 'credit-pack-later-refund',
        })
      ).resolves.toEqual({ processed: true });

      expect(await acquiredMicrodollars(user.id)).toBe(0);
      expect(
        await creditRowsForCategory(
          `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
        )
      ).toEqual([
        {
          id: expect.any(String),
          amountMicrodollars: -amountMicrodollars,
          creditCategory: `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`,
        },
      ]);
    });

    it('claws the pack back again when the store refunds it after a reversal', async () => {
      const user = await insertTestUser({ total_microdollars_acquired: 0 });
      const transactionId = `tx-${crypto.randomUUID()}`;
      const amountMicrodollars = toMicrodollars(10);
      await insertGrantedCreditPack({ userId: user.id, transactionId, amountMicrodollars });

      await refund({
        transactionId,
        signedDate: REFUND_SIGNED_AT_MS,
        notificationUUID: 'credit-pack-first-refund',
      });
      await refundReversed({
        transactionId,
        signedDate: REFUND_REVERSED_SIGNED_AT_MS,
        notificationUUID: 'credit-pack-first-reversal',
      });
      expect(await acquiredMicrodollars(user.id)).toBe(amountMicrodollars);

      // The store refunds the same pack again, signed after the reversal: the
      // settled first cycle must not leave the credits granted.
      await refund({
        transactionId,
        signedDate: REFUND_REVERSED_SIGNED_AT_MS + 60_000,
        notificationUUID: 'credit-pack-second-refund',
      });

      expect(await acquiredMicrodollars(user.id)).toBe(0);
      expect(
        await creditRowsForCategory(
          `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
        )
      ).toHaveLength(1);
      expect(
        await creditRowsForCategory(
          `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}:2`
        )
      ).toEqual([
        {
          id: expect.any(String),
          amountMicrodollars: -amountMicrodollars,
          creditCategory: `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}:2`,
        },
      ]);
    });

    it('credits a reversed refund of a pack Kilo never granted without blocking the grant', async () => {
      const user = await insertTestUser({ total_microdollars_acquired: 0 });
      const transactionId = `tx-${crypto.randomUUID()}`;

      await refund({
        transactionId,
        signedDate: REFUND_SIGNED_AT_MS,
        notificationUUID: 'credit-pack-refund-before-reversal-grant',
      });
      await expect(
        refundReversed({
          transactionId,
          signedDate: REFUND_REVERSED_SIGNED_AT_MS,
          notificationUUID: 'credit-pack-refund-before-reversal',
        })
      ).resolves.toEqual({ processed: true });

      expect(await acquiredMicrodollars(user.id)).toBe(0);
      const completion = await completeStoreCreditPurchase({
        user,
        purchase: {
          paymentProvider: KiloPassPaymentProvider.AppStore,
          productId: 'credits.usd10.v1',
          providerTransactionId: transactionId,
          appAccountToken: user.app_store_account_token,
          quantity: 1,
          amountUsd: 10,
          amountMicrodollars: toMicrodollars(10),
          purchasedAtIso: '2026-05-15T00:00:00.000Z',
          environment: 'Sandbox',
          rawPayload: {},
        },
      });

      expect(completion.alreadyProcessed).toBe(false);
      expect(await acquiredMicrodollars(user.id)).toBe(toMicrodollars(10));
    });
  });

  it('refuses a late completion of a credit pack whose refund was processed first', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const transactionId = `tx-${crypto.randomUUID()}`;

    // Apple refunds the pack before the client ever finishes the purchase — a
    // receipt saved at purchase time still replays a transaction the store has
    // already reversed. There is nothing to claw back, but the refund is
    // recorded, and that record is what the completion has to see.
    await expect(
      processAppStoreKiloPassNotification({
        signedPayload: 'credit-pack-refund-before-grant',
        decodeNotification: async () =>
          notification({
            notificationUUID: 'credit-pack-refund-before-grant',
            notificationType: NotificationTypeV2.REFUND,
            signedTransactionInfo: 'credit-pack-refund-before-grant-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            transactionId,
            productId: 'credits.usd10.v1',
            appAccountToken: user.app_store_account_token,
            revocationDate: Date.parse('2026-05-16T00:00:00.000Z'),
            revocationType: RevocationType.REFUND_FULL,
            revocationPercentage: 100_000,
          }),
      })
    ).resolves.toEqual({ processed: true });

    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'credit-pack-refund-before-grant'),
    });
    expect(event?.processed_at).not.toBeNull();
    expect(
      await db.query.credit_transactions.findFirst({
        where: eq(
          credit_transactions.credit_category,
          `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
        ),
      })
    ).toBeUndefined();

    await expect(
      completeStoreCreditPurchase({
        user,
        purchase: {
          paymentProvider: KiloPassPaymentProvider.AppStore,
          productId: 'credits.usd10.v1',
          providerTransactionId: transactionId,
          appAccountToken: user.app_store_account_token,
          quantity: 1,
          amountUsd: 10,
          amountMicrodollars: toMicrodollars(10),
          purchasedAtIso: '2026-05-15T00:00:00.000Z',
          environment: 'Sandbox',
          rawPayload: {},
        },
      })
    ).rejects.toThrow(STORE_PURCHASE_REFUNDED_MESSAGE);

    expect(
      await db.query.credit_transactions.findFirst({
        where: eq(
          credit_transactions.stripe_payment_id,
          storeCreditPaymentId(KiloPassPaymentProvider.AppStore, transactionId)
        ),
      })
    ).toBeUndefined();
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after?.total_microdollars_acquired).toBe(0);
  });

  it('leaves a credit-pack refund unprocessed when the clawback fails', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const transactionId = `tx-${crypto.randomUUID()}`;
    const amountMicrodollars = toMicrodollars(10);
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: amountMicrodollars,
      is_free: false,
      description: 'Credit purchase via App Store',
      stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.AppStore, transactionId),
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: amountMicrodollars })
      .where(eq(kilocode_users.id, user.id));

    mockReverseStoreCreditPurchase.mockRejectedValueOnce(new Error('credit reversal unavailable'));

    await expect(
      processAppStoreKiloPassNotification({
        signedPayload: 'credit-pack-refund-fail',
        decodeNotification: async () =>
          notification({
            notificationUUID: 'credit-pack-refund-fail',
            notificationType: NotificationTypeV2.REFUND,
            signedTransactionInfo: 'credit-pack-refund-fail-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            transactionId,
            productId: 'credits.usd10.v1',
            appAccountToken: user.app_store_account_token,
            revocationDate: Date.parse('2026-05-16T00:00:00.000Z'),
          }),
      })
    ).rejects.toThrow('credit reversal unavailable');

    // The event must stay unprocessed so the App Store redelivers it and the
    // idempotent reversal claws the pack back exactly once; marking it processed
    // would record a successful refund with the credits still granted.
    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'credit-pack-refund-fail'),
    });
    expect(event?.processed_at).toBeNull();

    // The transaction rolled back: no balance change and no success audit entry.
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after?.total_microdollars_acquired).toBe(amountMicrodollars);
    const audit = await db.query.kilo_pass_audit_log.findFirst({
      where: sql`${kilo_pass_audit_log.payload_json}->>'notificationUUID' = 'credit-pack-refund-fail'`,
    });
    expect(audit).toBeUndefined();
  });

  describe('credit pack proration', () => {
    async function grantAppStoreCreditPack(params: { acquiredUsd: number; usedUsd: number }) {
      const user = await insertTestUser({
        total_microdollars_acquired: toMicrodollars(params.acquiredUsd),
        microdollars_used: toMicrodollars(params.usedUsd),
      });
      const transactionId = `tx-${crypto.randomUUID()}`;
      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        amount_microdollars: toMicrodollars(10),
        is_free: false,
        description: 'Credit purchase via App Store',
        stripe_payment_id: storeCreditPaymentId(KiloPassPaymentProvider.AppStore, transactionId),
      });
      return { user, transactionId };
    }

    async function requestConsumption(transactionId: string, appAccountToken?: string) {
      const consumptionRequests: Array<{ transactionId: string; request: unknown }> = [];
      const result = await processAppStoreKiloPassNotification({
        signedPayload: 'credit-pack-consumption-request',
        decodeNotification: async () =>
          notification({ notificationType: NotificationTypeV2.CONSUMPTION_REQUEST }),
        decodeTransaction: async () =>
          transaction({
            transactionId,
            productId: 'credits.usd10.v1',
            expiresDate: undefined,
            appAccountToken,
          }),
        sendConsumptionInformation: async (sentTransactionId, request) => {
          consumptionRequests.push({ transactionId: sentTransactionId, request });
        },
      });
      expect(result).toEqual({ processed: true });
      return consumptionRequests;
    }

    async function refund(params: {
      transactionId: string;
      appAccountToken?: string;
      revocationType: RevocationType;
      revocationPercentage?: number;
    }) {
      return processAppStoreKiloPassNotification({
        signedPayload: 'credit-pack-prorated-refund',
        decodeNotification: async () =>
          notification({
            notificationType: NotificationTypeV2.REFUND,
            signedTransactionInfo: 'credit-pack-prorated-refund-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            transactionId: params.transactionId,
            productId: 'credits.usd10.v1',
            expiresDate: undefined,
            appAccountToken: params.appAccountToken,
            revocationDate: Date.parse('2026-05-16T00:00:00.000Z'),
            revocationType: params.revocationType,
            revocationPercentage: params.revocationPercentage,
          }),
      });
    }

    async function reversalsFor(transactionId: string) {
      return db
        .select()
        .from(credit_transactions)
        .where(
          eq(
            credit_transactions.credit_category,
            `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
          )
        );
    }

    it('asks Apple for a prorated refund of the unspent share of a partly spent pack', async () => {
      // $10 granted, $3 left: $7 of the pack is spent.
      const { user, transactionId } = await grantAppStoreCreditPack({
        acquiredUsd: 10,
        usedUsd: 7,
      });

      await expect(
        requestConsumption(transactionId, user.app_store_account_token)
      ).resolves.toEqual([
        {
          transactionId,
          request: {
            customerConsented: true,
            deliveryStatus: DeliveryStatus.DELIVERED,
            consumptionPercentage: 70_000,
            refundPreference: RefundPreference.GRANT_PRORATED,
            sampleContentProvided: false,
          },
        },
      ]);
    });

    it('reports an untouched pack as unconsumed despite earlier account spend', async () => {
      // $100 spent before the $10 pack was bought; none of the pack is used.
      const { user, transactionId } = await grantAppStoreCreditPack({
        acquiredUsd: 110,
        usedUsd: 100,
      });

      const [sent] = await requestConsumption(transactionId, user.app_store_account_token);
      expect(sent?.request).toMatchObject({
        consumptionPercentage: 0,
        refundPreference: RefundPreference.GRANT_PRORATED,
      });
    });

    it('declines a consumption request for a credit pack Kilo never granted', async () => {
      const [sent] = await requestConsumption(`tx-${crypto.randomUUID()}`);
      expect(sent?.request).toEqual({
        customerConsented: true,
        deliveryStatus: DeliveryStatus.DELIVERED,
        refundPreference: RefundPreference.DECLINE,
        sampleContentProvided: false,
      });
    });

    it('reverses only the refunded share of a prorated refund', async () => {
      const { user, transactionId } = await grantAppStoreCreditPack({
        acquiredUsd: 10,
        usedUsd: 7,
      });

      await expect(
        refund({
          transactionId,
          appAccountToken: user.app_store_account_token,
          revocationType: RevocationType.REFUND_PRORATED,
          revocationPercentage: 30_000,
        })
      ).resolves.toEqual({ processed: true });

      const reversals = await reversalsFor(transactionId);
      expect(reversals.map(row => row.amount_microdollars)).toEqual([-toMicrodollars(3)]);
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after?.total_microdollars_acquired).toBe(toMicrodollars(7));
    });

    it.each([
      { revocationType: RevocationType.REFUND_FULL, revocationPercentage: 100_000 },
      { revocationType: RevocationType.FAMILY_REVOKE, revocationPercentage: undefined },
      { revocationType: RevocationType.REFUND_PRORATED, revocationPercentage: undefined },
    ])(
      'reverses the whole pack for $revocationType with percentage $revocationPercentage',
      async ({ revocationType, revocationPercentage }) => {
        const { user, transactionId } = await grantAppStoreCreditPack({
          acquiredUsd: 10,
          usedUsd: 0,
        });

        await refund({
          transactionId,
          appAccountToken: user.app_store_account_token,
          revocationType,
          revocationPercentage,
        });

        const reversals = await reversalsFor(transactionId);
        expect(reversals.map(row => row.amount_microdollars)).toEqual([-toMicrodollars(10)]);
      }
    );

    it('keeps the first reversal when a refund is redelivered after more spend', async () => {
      const { user, transactionId } = await grantAppStoreCreditPack({
        acquiredUsd: 10,
        usedUsd: 7,
      });
      const appAccountToken = user.app_store_account_token;
      await refund({
        transactionId,
        appAccountToken,
        revocationType: RevocationType.REFUND_PRORATED,
        revocationPercentage: 30_000,
      });
      await db
        .update(kilocode_users)
        .set({ microdollars_used: toMicrodollars(9) })
        .where(eq(kilocode_users.id, user.id));

      // A fresh notification UUID bypasses the event claim, so only the
      // reversal's own idempotency key protects the stored amount.
      await expect(
        refund({
          transactionId,
          appAccountToken,
          revocationType: RevocationType.REFUND_FULL,
        })
      ).resolves.toEqual({ processed: true });

      const reversals = await reversalsFor(transactionId);
      expect(reversals.map(row => row.amount_microdollars)).toEqual([-toMicrodollars(3)]);
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after?.total_microdollars_acquired).toBe(toMicrodollars(7));
    });
  });
  it('reports a production credit-pack refund for the pack owner', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const transactionId = `tx-${crypto.randomUUID()}`;
    await completeStoreCreditPurchase({
      user,
      purchase: {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        productId: 'credits.usd10.v1',
        providerTransactionId: transactionId,
        appAccountToken: user.app_store_account_token,
        quantity: 1,
        amountUsd: 10,
        amountMicrodollars: toMicrodollars(10),
        purchasedAtIso: '2026-05-15T00:00:00.000Z',
        environment: 'Production',
        rawPayload: {},
      },
    });
    // The refund carries no account token, so only the grant row names the owner.
    const refundTransaction = transaction({
      transactionId,
      originalTransactionId: transactionId,
      productId: 'credits.usd10.v1',
      revocationDate: REFUND_SIGNED_AT_MS,
      revocationType: RevocationType.REFUND_FULL,
      revocationPercentage: 100_000,
    });
    const notificationUUID = `bouncer-credit-pack-${crypto.randomUUID()}`;

    await processAppStoreKiloPassNotification({
      signedPayload: notificationUUID,
      decodeNotification: async () =>
        notification({
          notificationUUID,
          notificationType: NotificationTypeV2.REFUND,
          environment: 'Production',
          signedDate: REFUND_SIGNED_AT_MS,
        }),
      decodeTransaction: async () => refundTransaction,
    });

    const clawback = await db.query.credit_transactions.findFirst({
      where: eq(
        credit_transactions.credit_category,
        `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
      ),
    });
    expect(clawback?.amount_microdollars).toBe(-toMicrodollars(10));
    expect(
      await db.query.bouncer_credit_event_outbox.findFirst({
        where: eq(bouncer_credit_event_outbox.event_id, notificationUUID),
      })
    ).toMatchObject({
      event_type: 'store.refund',
      payload: {
        type: 'store.refund',
        reason: 'other',
        provider: 'apple',
        eventId: notificationUUID,
        userId: user.id,
        referenceId: transactionId,
        environment: 'production',
      },
    });
  });

  it('records and acknowledges notifications without transaction info', async () => {
    const decodedNotification = notification({ signedTransactionInfo: undefined });
    const decodeTransaction = jest.fn<() => Promise<AppleStoreDecodedTransaction>>();
    await expect(
      processAppStoreKiloPassNotification({
        signedPayload: 'no-transaction',
        decodeNotification: async () => decodedNotification,
        decodeTransaction,
      })
    ).resolves.toEqual({ processed: true });
    expect(decodeTransaction).not.toHaveBeenCalled();
    expect(
      await db.query.kilo_pass_store_events.findFirst({
        where: eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID),
      })
    ).toMatchObject({ product_id: 'unknown', processed_at: expect.any(String) });
  });

  it('rolls back a credit-pack refund when its durable report cannot be enqueued', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const transactionId = `tx-${crypto.randomUUID()}`;
    const amountMicrodollars = toMicrodollars(10);
    await insertGrantedCreditPack({ userId: user.id, transactionId, amountMicrodollars });
    const decodedNotification = notification({
      notificationType: NotificationTypeV2.REFUND,
      environment: 'Production',
      signedDate: REFUND_SIGNED_AT_MS,
    });
    getEnqueueCreditEventMock().mockRejectedValueOnce(new Error('enqueue unavailable'));
    await expect(
      processAppStoreKiloPassNotification({
        signedPayload: 'report-failure',
        decodeNotification: async () => decodedNotification,
        decodeTransaction: async () =>
          transaction({
            transactionId,
            productId: 'credits.usd10.v1',
            revocationType: RevocationType.REFUND_FULL,
          }),
      })
    ).rejects.toThrow('enqueue unavailable');
    expect(
      await db.query.kilo_pass_store_events.findFirst({
        where: eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID),
      })
    ).toMatchObject({ processed_at: null });
    expect(
      await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      })
    ).toMatchObject({ total_microdollars_acquired: amountMicrodollars });
    expect(
      await creditRowsForCategory(
        `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
      )
    ).toEqual([]);
  });
});
