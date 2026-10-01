import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  DeliveryStatus,
  NotificationTypeV2,
  RefundPreference,
  RevocationType,
  Subtype,
} from '@apple/app-store-server-library';
import { and, eq } from 'drizzle-orm';

import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilocode_users,
  kilo_pass_audit_log,
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  KiloPassAuditLogAction,
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassPaymentProvider,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import type * as AppleStoreNotifications from './apple-store-notifications';
import type { AppleStoreDecodedNotification } from './apple-store-notifications';
import type { AppleStoreDecodedTransaction } from './apple-store-verifier';
import type * as StoreRefund from '@/lib/credits/store-refund';
import type * as bouncerClientModule from '@/lib/bouncer/client';
import { toMicrodollars } from '@/lib/microdollars';
import { storeCreditPaymentId } from '@/lib/credits/store-products';
import { completeStoreCreditPurchase } from '@/lib/credits/store-completion';

// SWC + static ESM imports do not see jest.mock replacements on the same module id.
// Dynamic-import the SUT after the mock (same pattern as stripe-handlers-invoice-paid.test.ts).
jest.mock('@/lib/kilo-pass/posthog-tracking', () => ({
  runAfterResponse: async (work: () => Promise<void>) => {
    await work();
  },
  trackKiloPassPurchaseCompleted: jest.fn(),
}));

// Bouncer is report-only. Capture its calls without any network access.
jest.mock('@/lib/bouncer/client', () => {
  const actual = jest.requireActual<typeof bouncerClientModule>('@/lib/bouncer/client');
  return {
    __esModule: true,
    ...actual,
    reportCreditEvent: jest.fn(),
  };
});

// The mock is registered above; a static import would bind the real module instead.
type BouncerClientMock = {
  reportCreditEvent: jest.Mock;
};

function getBouncerClientMock(): jest.Mock {
  return (jest.requireMock('@/lib/bouncer/client') as BouncerClientMock).reportCreditEvent;
}

type PosthogTrackingMock = {
  trackKiloPassPurchaseCompleted: jest.Mock;
  runAfterResponse: (work: () => Promise<void>) => Promise<void>;
};

function getPosthogTrackingMock(): PosthogTrackingMock {
  return jest.requireMock('@/lib/kilo-pass/posthog-tracking') as PosthogTrackingMock;
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
    getPosthogTrackingMock().trackKiloPassPurchaseCompleted.mockClear();
    mockReverseStoreCreditPurchase.mockClear();
  });

  describe('kilo_pass_purchase_completed tracking', () => {
    it('does not track when the notification UUID was already processed', async () => {
      const trackingMock = getPosthogTrackingMock();
      const user = await insertTestUser();
      const decodedNotification = notification();
      const decodedTransaction = transaction({
        appAccountToken: user.app_store_account_token,
      });
      const params = {
        signedPayload: 'payload',
        decodeNotification: async () => decodedNotification,
        decodeTransaction: async () => decodedTransaction,
      };

      await processAppStoreKiloPassNotification(params);
      trackingMock.trackKiloPassPurchaseCompleted.mockClear();

      const replay = await processAppStoreKiloPassNotification(params);
      expect(replay).toEqual({ processed: true, status: 'already_processed' });
      expect(trackingMock.trackKiloPassPurchaseCompleted).not.toHaveBeenCalled();
    });

    it('does not track when the provider transaction was already recorded by the app', async () => {
      const trackingMock = getPosthogTrackingMock();
      const user = await insertTestUser();
      const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
      const providerTransactionId = `tx-${crypto.randomUUID()}`;
      const decodedTransaction = transaction({
        originalTransactionId: providerSubscriptionId,
        transactionId: providerTransactionId,
        appAccountToken: user.app_store_account_token,
      });

      // App path records the purchase first (same provider transaction id).
      await processAppStoreKiloPassNotification({
        signedPayload: 'app-first-initial',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.SUBSCRIBED,
            subtype: Subtype.INITIAL_BUY,
          }),
        decodeTransaction: async () => decodedTransaction,
      });
      trackingMock.trackKiloPassPurchaseCompleted.mockClear();

      const result = await processAppStoreKiloPassNotification({
        signedPayload: 'assn-same-tx',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.DID_RENEW,
          }),
        decodeTransaction: async () => decodedTransaction,
      });

      expect(result).toEqual({ processed: true });
      expect(trackingMock.trackKiloPassPurchaseCompleted).not.toHaveBeenCalled();
    });

    it('tracks DID_RENEW with a new transaction as renewal', async () => {
      const trackingMock = getPosthogTrackingMock();
      const user = await insertTestUser();
      const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

      await processAppStoreKiloPassNotification({
        signedPayload: 'renewal-initial',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.SUBSCRIBED,
            subtype: Subtype.INITIAL_BUY,
          }),
        decodeTransaction: async () =>
          transaction({
            originalTransactionId: providerSubscriptionId,
            appAccountToken: user.app_store_account_token,
          }),
      });
      trackingMock.trackKiloPassPurchaseCompleted.mockClear();

      const renewalTransaction = transaction({
        originalTransactionId: providerSubscriptionId,
        transactionId: `tx-${crypto.randomUUID()}`,
        appAccountToken: user.app_store_account_token,
      });
      const result = await processAppStoreKiloPassNotification({
        signedPayload: 'renewal',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.DID_RENEW,
          }),
        decodeTransaction: async () => renewalTransaction,
      });

      expect(result).toEqual({ processed: true });
      expect(trackingMock.trackKiloPassPurchaseCompleted).toHaveBeenCalledTimes(1);
      expect(trackingMock.trackKiloPassPurchaseCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'app_store',
          distinctId: user.google_user_email,
          userId: user.id,
          purchaseKind: 'renewal',
          providerTransactionId: renewalTransaction.transactionId,
          productId: renewalTransaction.productId,
          environment: renewalTransaction.environment,
        })
      );
    });

    it('grants a DID_RENEW that arrives after its renewal period ended', async () => {
      const user = await insertTestUser();
      const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

      await processAppStoreKiloPassNotification({
        signedPayload: 'late-renewal-initial',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.SUBSCRIBED,
            subtype: Subtype.INITIAL_BUY,
          }),
        decodeTransaction: async () =>
          transaction({
            originalTransactionId: providerSubscriptionId,
            appAccountToken: user.app_store_account_token,
            purchaseDate: Date.parse('2026-04-01T09:00:00.000Z'),
            expiresDate: Date.parse('2026-05-01T09:00:00.000Z'),
          }),
      });

      // The clock is 2026-05-15. The May renewal period ended before its
      // notification arrived.
      const lateRenewal = transaction({
        originalTransactionId: providerSubscriptionId,
        transactionId: `tx-${crypto.randomUUID()}`,
        appAccountToken: user.app_store_account_token,
        purchaseDate: Date.parse('2026-05-01T09:00:00.000Z'),
        expiresDate: APP_STORE_NOTIFICATION_TEST_NOW_MS - 60_000,
      });
      const result = await processAppStoreKiloPassNotification({
        signedPayload: 'late-renewal',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.DID_RENEW,
          }),
        decodeTransaction: async () => lateRenewal,
      });

      expect(result).toEqual({ processed: true });
      const renewalGrant = await db.query.credit_transactions.findFirst({
        where: eq(
          credit_transactions.stripe_payment_id,
          `kilo-pass:${KiloPassPaymentProvider.AppStore}:${lateRenewal.transactionId}`
        ),
      });
      expect(renewalGrant?.amount_microdollars).toBe(toMicrodollars(19));
    });

    it('tracks SUBSCRIBED with a resolved user and new transaction as initial', async () => {
      const trackingMock = getPosthogTrackingMock();
      const user = await insertTestUser();
      const decodedTransaction = transaction({
        appAccountToken: user.app_store_account_token,
      });

      const result = await processAppStoreKiloPassNotification({
        signedPayload: 'subscribed-initial',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.SUBSCRIBED,
            subtype: Subtype.INITIAL_BUY,
          }),
        decodeTransaction: async () => decodedTransaction,
      });

      expect(result).toEqual({ processed: true });
      expect(trackingMock.trackKiloPassPurchaseCompleted).toHaveBeenCalledTimes(1);
      expect(trackingMock.trackKiloPassPurchaseCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'app_store',
          distinctId: user.google_user_email,
          userId: user.id,
          purchaseKind: 'initial',
          providerTransactionId: decodedTransaction.transactionId,
          productId: decodedTransaction.productId,
          environment: decodedTransaction.environment,
        })
      );
    });

    it('forwards purchaseKind from completion on DID_CHANGE_RENEWAL_PREF UPGRADE', async () => {
      const trackingMock = getPosthogTrackingMock();
      const user = await insertTestUser();
      const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

      await processAppStoreKiloPassNotification({
        signedPayload: 'upgrade-initial',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.SUBSCRIBED,
            subtype: Subtype.INITIAL_BUY,
          }),
        decodeTransaction: async () =>
          transaction({
            originalTransactionId: providerSubscriptionId,
            appAccountToken: user.app_store_account_token,
          }),
      });
      trackingMock.trackKiloPassPurchaseCompleted.mockClear();

      const upgradeTransaction = transaction({
        originalTransactionId: providerSubscriptionId,
        transactionId: `tx-${crypto.randomUUID()}`,
        productId: 'kilopass.tier49.monthly.v1',
        appAccountToken: user.app_store_account_token,
      });
      const result = await processAppStoreKiloPassNotification({
        signedPayload: 'upgrade-pref',
        decodeNotification: async () =>
          notification({
            notificationUUID: `note-${crypto.randomUUID()}`,
            notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_PREF,
            subtype: Subtype.UPGRADE,
          }),
        decodeTransaction: async () => upgradeTransaction,
      });

      expect(result).toEqual({ processed: true });
      expect(trackingMock.trackKiloPassPurchaseCompleted).toHaveBeenCalledTimes(1);
      // tier19 → tier49 within the previous purchase's period classifies as a
      // same-period upgrade in completeStoreKiloPassPurchase (pinned in slice 1);
      // this asserts the kind is forwarded through the ASSN path.
      expect(trackingMock.trackKiloPassPurchaseCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'app_store',
          distinctId: user.google_user_email,
          userId: user.id,
          purchaseKind: 'upgrade',
          providerTransactionId: upgradeTransaction.transactionId,
          productId: upgradeTransaction.productId,
          environment: upgradeTransaction.environment,
        })
      );
    });
  });

  it('records a renewal notification and completes the subscription once', async () => {
    const user = await insertTestUser();
    const decodedNotification = notification();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const events = await db
      .select()
      .from(kilo_pass_store_events)
      .where(eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID));
    expect(events).toHaveLength(1);
    expect(events[0]?.payment_provider).toBe(KiloPassPaymentProvider.AppStore);
    expect(events[0]?.app_account_token).toBe(user.app_store_account_token);

    const eventPayloadJson = JSON.stringify(events[0]?.payload_json);
    expect(eventPayloadJson).not.toContain(user.app_store_account_token);
    expect(events[0]?.payload_json).toMatchObject({
      notificationType: decodedNotification.notificationType,
      rawTransaction: {
        providerTransactionId: decodedTransaction.transactionId,
        providerSubscriptionId: decodedTransaction.originalTransactionId,
      },
      transaction: {
        providerTransactionId: decodedTransaction.transactionId,
        providerSubscriptionId: decodedTransaction.originalTransactionId,
      },
    });

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.kilo_user_id, user.id));
    expect(subscriptions).toHaveLength(1);
  });

  it('deduplicates notification UUIDs', async () => {
    const user = await insertTestUser();
    const decodedNotification = notification();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    const params = {
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    };

    await processAppStoreKiloPassNotification(params);
    const replay = await processAppStoreKiloPassNotification(params);

    expect(replay).toEqual({ processed: true, status: 'already_processed' });
  });

  it('does not process concurrent duplicate notification deliveries twice', async () => {
    const decodedNotification = notification({
      notificationUUID: 'concurrent-consumption-request',
      notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
    });
    const decodedTransaction = transaction();
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
    const decodedTransaction = transaction();
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

  it('records initial buy notifications before the app attaches a user', async () => {
    const decodedNotification = notification({
      notificationType: NotificationTypeV2.SUBSCRIBED,
      subtype: Subtype.INITIAL_BUY,
    });
    const decodedTransaction = transaction();

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const events = await db
      .select()
      .from(kilo_pass_store_events)
      .where(eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID));
    expect(events[0]?.processed_at).not.toBeNull();

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(
        eq(
          kilo_pass_subscriptions.provider_subscription_id,
          decodedTransaction.originalTransactionId
        )
      );
    expect(subscriptions).toHaveLength(0);
  });

  it('creates the initial subscription from the App Store account token', async () => {
    const user = await insertTestUser();
    const decodedNotification = notification({
      notificationType: NotificationTypeV2.SUBSCRIBED,
      subtype: Subtype.INITIAL_BUY,
    });
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.kilo_user_id, user.id));
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.provider_subscription_id).toBe(
      decodedTransaction.originalTransactionId
    );
  });

  it('reprocesses notification rows left unprocessed by an earlier failure', async () => {
    const decodedNotification = notification({
      notificationType: NotificationTypeV2.SUBSCRIBED,
      subtype: Subtype.INITIAL_BUY,
    });
    const decodedTransaction = transaction();
    await db.insert(kilo_pass_store_events).values({
      payment_provider: KiloPassPaymentProvider.AppStore,
      event_id: decodedNotification.notificationUUID,
      provider_subscription_id: decodedTransaction.originalTransactionId,
      provider_transaction_id: decodedTransaction.transactionId,
      product_id: decodedTransaction.productId,
      environment: 'Sandbox',
      payload_json: {
        notificationType: decodedNotification.notificationType,
        subtype: decodedNotification.subtype,
      },
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const events = await db
      .select()
      .from(kilo_pass_store_events)
      .where(eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID));
    expect(events[0]?.processed_at).not.toBeNull();
  });

  it('marks a subscription ended for expiration notifications', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    await processAppStoreKiloPassNotification({
      signedPayload: 'renewal',
      decodeNotification: async () => notification({ notificationUUID: 'renewal' }),
      decodeTransaction: async () => decodedTransaction,
    });

    await processAppStoreKiloPassNotification({
      signedPayload: 'expired',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'expired',
          notificationType: NotificationTypeV2.EXPIRED,
          signedTransactionInfo: 'expired-transaction',
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('canceled');
    expect(subscription?.ended_at).not.toBeNull();
  });

  it('marks a subscription ended when the expiration notification transaction is expired', async () => {
    const user = await insertTestUser();
    const renewalTransaction = transaction({ appAccountToken: user.app_store_account_token });
    await processAppStoreKiloPassNotification({
      signedPayload: 'expired-transaction-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'expired-transaction-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => renewalTransaction,
    });

    await processAppStoreKiloPassNotification({
      signedPayload: 'expired-transaction-expired',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'expired-transaction-expired',
          notificationType: NotificationTypeV2.EXPIRED,
          signedTransactionInfo: 'expired-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: renewalTransaction.originalTransactionId,
          expiresDate: 1_700_000_000_000,
        }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        renewalTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('canceled');
    expect(subscription?.ended_at).not.toBeNull();
  });

  it('only ends App Store rows for expiration notifications', async () => {
    const providerSubscriptionId = `shared-${crypto.randomUUID()}`;
    const { stripeSubscriptionId } =
      await insertProviderScopedSubscriptionRows(providerSubscriptionId);

    await processAppStoreKiloPassNotification({
      signedPayload: 'expired-provider-scoped',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'expired-provider-scoped',
          notificationType: NotificationTypeV2.EXPIRED,
          signedTransactionInfo: 'expired-provider-scoped-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
        }),
    });

    const [stripeSubscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubscriptionId));
    const [appStoreSubscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId));

    expect(stripeSubscription).toMatchObject({
      status: 'active',
      ended_at: null,
    });
    expect(appStoreSubscription).toMatchObject({
      status: 'canceled',
      cancel_at_period_end: false,
    });
    expect(appStoreSubscription?.ended_at).not.toBeNull();
  });

  it('marks auto-renew-disabled notifications as canceling at period end and enabled as resumed', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    await processAppStoreKiloPassNotification({
      signedPayload: 'auto-renew-disabled',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'auto-renew-disabled',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
          subtype: Subtype.AUTO_RENEW_DISABLED,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.cancel_at_period_end).toBe(true);
    expect(subscription?.ended_at).toBeNull();

    await processAppStoreKiloPassNotification({
      signedPayload: 'auto-renew-enabled',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'auto-renew-enabled',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
          subtype: Subtype.AUTO_RENEW_ENABLED,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const resumedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(resumedSubscription?.status).toBe('active');
    expect(resumedSubscription?.cancel_at_period_end).toBe(false);
    expect(resumedSubscription?.ended_at).toBeNull();
  });

  it('only marks App Store rows canceling at period end', async () => {
    const providerSubscriptionId = `shared-${crypto.randomUUID()}`;
    const { stripeSubscriptionId } =
      await insertProviderScopedSubscriptionRows(providerSubscriptionId);

    await processAppStoreKiloPassNotification({
      signedPayload: 'auto-renew-disabled-provider-scoped',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'auto-renew-disabled-provider-scoped',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
          subtype: Subtype.AUTO_RENEW_DISABLED,
          signedTransactionInfo: 'auto-renew-disabled-provider-scoped-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
        }),
    });

    const [stripeSubscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubscriptionId));
    const [appStoreSubscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId));

    expect(stripeSubscription?.cancel_at_period_end).toBe(false);
    expect(appStoreSubscription?.cancel_at_period_end).toBe(true);
  });

  it('uses the App Store row when resolving renewal users', async () => {
    const providerSubscriptionId = `shared-${crypto.randomUUID()}`;
    const { stripeUser, appStoreUser } =
      await insertProviderScopedSubscriptionRows(providerSubscriptionId);

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'renewal-provider-scoped',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'renewal-provider-scoped',
          notificationType: NotificationTypeV2.DID_RENEW,
          signedTransactionInfo: 'renewal-provider-scoped-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          appAccountToken: appStoreUser.app_store_account_token,
        }),
    });

    expect(result).toEqual({ processed: true });

    const stripeStorePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, stripeUser.id));
    expect(stripeStorePurchases).toHaveLength(0);

    const appStorePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, appStoreUser.id));
    expect(appStorePurchases).toHaveLength(1);
  });

  it('rejects renewal notifications whose account token does not match the App Store owner', async () => {
    const owner = await insertTestUser();
    const otherUser = await insertTestUser();
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    await processAppStoreKiloPassNotification({
      signedPayload: 'mismatch-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'mismatch-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          appAccountToken: owner.app_store_account_token,
        }),
    });

    const ownerCreditTransactionsBefore = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, owner.id));

    await expect(
      processAppStoreKiloPassNotification({
        signedPayload: 'mismatch-renewal',
        decodeNotification: async () =>
          notification({
            notificationUUID: 'mismatch-renewal',
            notificationType: NotificationTypeV2.DID_RENEW,
            signedTransactionInfo: 'mismatch-renewal-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            originalTransactionId: providerSubscriptionId,
            transactionId: `tx-${crypto.randomUUID()}`,
            appAccountToken: otherUser.app_store_account_token,
          }),
      })
    ).rejects.toThrow('App Store renewal account token does not match subscription owner');

    const mismatchEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'mismatch-renewal'),
    });
    expect(mismatchEvent?.processed_at).toBeNull();

    const otherUserPurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, otherUser.id));
    expect(otherUserPurchases).toHaveLength(0);

    const ownerCreditTransactionsAfter = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, owner.id));
    expect(ownerCreditTransactionsAfter).toHaveLength(ownerCreditTransactionsBefore.length);
  });

  it('marks the event processed and returns no subscription when the store purchase mismatches', async () => {
    const user = await insertTestUser();
    const existingSubscriptionId = `orig-${crypto.randomUUID()}`;
    await processAppStoreKiloPassNotification({
      signedPayload: 'mismatch-active-sub-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'mismatch-active-sub-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: existingSubscriptionId,
          appAccountToken: user.app_store_account_token,
        }),
    });

    // A renewal for a different provider subscription resolves to the same user,
    // whose active subscription makes the completion settle a permanent mismatch.
    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'mismatch-active-sub-renewal',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'mismatch-active-sub-renewal',
          notificationType: NotificationTypeV2.DID_RENEW,
          signedTransactionInfo: 'mismatch-active-sub-renewal-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: `orig-${crypto.randomUUID()}`,
          transactionId: `tx-${crypto.randomUUID()}`,
          appAccountToken: user.app_store_account_token,
        }),
    });

    expect(result).toEqual({ processed: true });
    expect(result).not.toHaveProperty('subscriptionId');

    const mismatchEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'mismatch-active-sub-renewal'),
    });
    expect(mismatchEvent?.processed_at).not.toBeNull();
  });

  it('applies App Store upgrade renewal preference notifications immediately', async () => {
    const user = await insertTestUser();
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'upgrade-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          appAccountToken: user.app_store_account_token,
        }),
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'upgrade',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'upgrade',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_PREF,
          subtype: Subtype.UPGRADE,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: `tx-${crypto.randomUUID()}`,
          productId: 'kilopass.tier49.monthly.v1',
          appAccountToken: user.app_store_account_token,
        }),
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    expect(subscription?.tier).toBe(KiloPassTier.Tier49);
    expect(subscription?.status).toBe('active');
  });

  it('records failed-renewal notifications without ending the subscription', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'failed-renewal-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'failed-renewal',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'failed-renewal',
          notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.cancel_at_period_end).toBe(false);
    expect(subscription?.ended_at).toBeNull();

    const auditRow = await db.query.kilo_pass_audit_log.findFirst({
      where: sql`${kilo_pass_audit_log.action} = ${KiloPassAuditLogAction.StoreNotificationReceived} AND ${kilo_pass_audit_log.payload_json}->>'notificationUUID' = 'failed-renewal'`,
    });
    expect(auditRow?.payload_json).toMatchObject({
      notificationUUID: 'failed-renewal',
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
      providerSubscriptionId: decodedTransaction.originalTransactionId,
    });
  });

  it('asks Apple to decline refund requests without ending the subscription', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    const consumptionRequests: Array<{ transactionId: string; request: unknown }> = [];
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'consumption-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'consumption-request',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'consumption-request',
          notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
        }),
      decodeTransaction: async () => decodedTransaction,
      sendConsumptionInformation: async (transactionId, request) => {
        consumptionRequests.push({ transactionId, request });
      },
    });

    expect(result).toEqual({ processed: true });
    expect(consumptionRequests).toEqual([
      {
        transactionId: decodedTransaction.transactionId,
        request: {
          customerConsented: true,
          deliveryStatus: DeliveryStatus.DELIVERED,
          refundPreference: RefundPreference.DECLINE,
          sampleContentProvided: false,
        },
      },
    ]);

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.ended_at).toBeNull();
  });

  it('asks Apple to decline refund requests regardless of credit usage', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    const consumptionRequests: Array<{ transactionId: string; request: unknown }> = [];
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'consumed-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 1 })
      .where(eq(kilocode_users.id, user.id));

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'consumed-consumption-request',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'consumed-consumption-request',
          notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
        }),
      decodeTransaction: async () => decodedTransaction,
      sendConsumptionInformation: async (transactionId, request) => {
        consumptionRequests.push({ transactionId, request });
      },
    });

    expect(result).toEqual({ processed: true });
    expect(consumptionRequests).toEqual([
      {
        transactionId: decodedTransaction.transactionId,
        request: {
          customerConsented: true,
          deliveryStatus: DeliveryStatus.DELIVERED,
          refundPreference: RefundPreference.DECLINE,
          sampleContentProvided: false,
        },
      },
    ]);

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.ended_at).toBeNull();
  });

  it('does not activate or issue credits when a refund is processed before the purchase notification', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const providerTransactionId = `tx-${crypto.randomUUID()}`;

    const refundResult = await processAppStoreKiloPassNotification({
      signedPayload: 'refund-before-subscribe',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'refund-before-subscribe',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'refund-before-subscribe-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: providerTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-05-01T00:00:00.000Z'),
          revocationDate: Date.parse('2026-05-02T00:00:00.000Z'),
        }),
    });
    expect(refundResult).toEqual({ processed: true });

    const subscribeResult = await processAppStoreKiloPassNotification({
      signedPayload: 'subscribe-after-refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'subscribe-after-refund',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
          signedTransactionInfo: 'subscribe-after-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: providerTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-05-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-06-01T00:00:00.000Z'),
        }),
    });
    expect(subscribeResult).toEqual({ processed: true });

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId));
    expect(
      subscriptions.filter(row => row.status === 'active' && row.ended_at === null)
    ).toHaveLength(0);

    const storePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.provider_transaction_id, providerTransactionId));
    expect(storePurchases).toHaveLength(0);

    const userCreditTransactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(userCreditTransactions).toHaveLength(0);

    const stalePurchaseAudit = await db.query.kilo_pass_audit_log.findFirst({
      where: sql`${kilo_pass_audit_log.action} = ${KiloPassAuditLogAction.StoreNotificationReceived} AND ${kilo_pass_audit_log.payload_json}->>'notificationUUID' = 'subscribe-after-refund'`,
    });
    expect(stalePurchaseAudit?.payload_json).toMatchObject({
      notificationUUID: 'subscribe-after-refund',
      notificationType: NotificationTypeV2.SUBSCRIBED,
      providerSubscriptionId,
      providerTransactionId,
      skippedStorePurchaseCompletion: true,
    });
  });

  it('does not reactivate a subscription for a delayed renewal predating a terminal event', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const initialTransactionId = `tx-${crypto.randomUUID()}`;
    const delayedRenewalTransactionId = `tx-${crypto.randomUUID()}`;
    const terminalTransactionId = `tx-${crypto.randomUUID()}`;

    await processAppStoreKiloPassNotification({
      signedPayload: 'delayed-terminal-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'delayed-terminal-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: initialTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-05-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-06-01T00:00:00.000Z'),
        }),
    });

    const creditTransactionsBeforeTerminal = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    await processAppStoreKiloPassNotification({
      signedPayload: 'terminal-before-delayed-renewal',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'terminal-before-delayed-renewal',
          notificationType: NotificationTypeV2.REVOKE,
          signedTransactionInfo: 'terminal-before-delayed-renewal-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: terminalTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-06-10T00:00:00.000Z'),
          revocationDate: Date.parse('2026-06-15T00:00:00.000Z'),
        }),
    });

    const delayedRenewalResult = await processAppStoreKiloPassNotification({
      signedPayload: 'delayed-renewal-after-terminal',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'delayed-renewal-after-terminal',
          notificationType: NotificationTypeV2.DID_RENEW,
          signedTransactionInfo: 'delayed-renewal-after-terminal-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: delayedRenewalTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-06-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-07-01T00:00:00.000Z'),
        }),
    });
    expect(delayedRenewalResult).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    expect(subscription?.status).toBe('canceled');
    expect(subscription?.ended_at).not.toBeNull();

    const delayedStorePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.provider_transaction_id, delayedRenewalTransactionId));
    expect(delayedStorePurchases).toHaveLength(0);

    const creditTransactionsAfterDelayedRenewal = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(creditTransactionsAfterDelayedRenewal).toHaveLength(
      creditTransactionsBeforeTerminal.length
    );
  });

  it('reverses the granted base amount plus issued bonus and promo credits for the refunded issuance', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({
      appAccountToken: user.app_store_account_token,
      currency: 'USD',
      price: 24700,
    });
    await processAppStoreKiloPassNotification({
      signedPayload: 'refund-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'refund-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription).toBeDefined();

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
    });
    expect(issuance).toBeDefined();

    const [bonusTransaction, promoTransaction] = await Promise.all([
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(9.5),
          is_free: true,
          description: 'test Kilo Pass bonus credits',
          credit_category: `test-kilo-pass-bonus-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(4.75),
          is_free: true,
          description: 'test Kilo Pass promo credits',
          credit_category: `test-kilo-pass-promo-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
    ]);

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(
          14.25
        )}`,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_issuance_items).values([
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.Bonus,
        credit_transaction_id: bonusTransaction[0]?.id ?? '',
        amount_usd: 9.5,
        bonus_percent_applied: 0.5,
      },
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        credit_transaction_id: promoTransaction[0]?.id ?? '',
        amount_usd: 4.75,
        bonus_percent_applied: 0.25,
      },
    ]);

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'refund',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          ...decodedTransaction,
          revocationDate: 1_777_700_000_000,
          currency: 'USD',
          price: 24700,
        }),
    });

    expect(result).toEqual({ processed: true });

    const replayedResult = await processAppStoreKiloPassNotification({
      signedPayload: 'revoke',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'revoke',
          notificationType: NotificationTypeV2.REVOKE,
          signedTransactionInfo: 'revoke-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          ...decodedTransaction,
          revocationDate: 1_777_700_000_000,
          currency: 'USD',
          price: 24700,
        }),
    });
    expect(replayedResult).toEqual({ processed: true });

    const creditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(creditTransactions.filter(row => row.amountMicrodollars < 0)).toHaveLength(3);
    expect(creditTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(19),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(9.5),
          description: 'App Store Kilo Pass bonus refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(4.75),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );

    // Granted credits are reversed in full, so the refund leaves the acquired
    // total exactly where it started rather than minus the App Store margin.
    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(0);
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

    // The refund is still recorded as a processed store event, exactly like a
    // Kilo Pass refund, so a replay cannot reverse the pack twice.
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

  it('scopes App Store refund reversals to the refunded transaction after a same-month upgrade', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const tx1 = `tx-${crypto.randomUUID()}`;
    const tx2 = `tx-${crypto.randomUUID()}`;

    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-refund-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-refund-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx1,
          productId: 'kilopass.tier19.monthly.v1',
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-06-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-07-01T00:00:00.000Z'),
          currency: 'USD',
          price: 19000,
        }),
    });

    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-refund-upgrade',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-refund-upgrade',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_PREF,
          subtype: Subtype.UPGRADE,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx2,
          productId: 'kilopass.tier49.monthly.v1',
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-06-16T00:00:00.000Z'),
          expiresDate: Date.parse('2026-07-16T00:00:00.000Z'),
          currency: 'USD',
          price: 49000,
        }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    expect(subscription).toBeDefined();

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
        eq(kilo_pass_issuances.issue_month, '2026-06-01')
      ),
    });
    expect(issuance).toBeDefined();

    const [bonusTransaction, promoTransaction] = await Promise.all([
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(24.5),
          is_free: true,
          description: 'test tx2 Kilo Pass bonus credits',
          credit_category: `test-kilo-pass-bonus-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(12.25),
          is_free: true,
          description: 'test tx2 Kilo Pass promo credits',
          credit_category: `test-kilo-pass-promo-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
    ]);

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(
          36.75
        )}`,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_issuance_items).values([
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.Bonus,
        credit_transaction_id: bonusTransaction[0]?.id ?? '',
        amount_usd: 24.5,
        bonus_percent_applied: 0.5,
      },
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        credit_transaction_id: promoTransaction[0]?.id ?? '',
        amount_usd: 12.25,
        bonus_percent_applied: 0.25,
      },
    ]);

    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-refund-tx1',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-refund-tx1',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'scoped-refund-tx1-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx1,
          productId: 'kilopass.tier19.monthly.v1',
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-20T00:00:00.000Z'),
          currency: 'USD',
          price: 19000,
        }),
    });

    let negativeCreditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(negativeCreditTransactions.filter(row => row.amountMicrodollars < 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(19),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(9.5),
          description: 'Kilo Pass upgrade refund clawback (tier_19)',
        }),
      ])
    );
    expect(negativeCreditTransactions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(49),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(24.5),
          description: 'App Store Kilo Pass bonus refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(12.25),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );

    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-refund-tx2',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-refund-tx2',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'scoped-refund-tx2-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx2,
          productId: 'kilopass.tier49.monthly.v1',
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-21T00:00:00.000Z'),
          currency: 'USD',
          price: 49000,
        }),
    });
    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-revoke-tx2',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-revoke-tx2',
          notificationType: NotificationTypeV2.REVOKE,
          signedTransactionInfo: 'scoped-revoke-tx2-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx2,
          productId: 'kilopass.tier49.monthly.v1',
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-21T00:00:00.000Z'),
          currency: 'USD',
          price: 49000,
        }),
    });

    negativeCreditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(negativeCreditTransactions.filter(row => row.amountMicrodollars < 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(19),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(49),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(24.5),
          description: 'App Store Kilo Pass bonus refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(12.25),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );
    expect(
      negativeCreditTransactions.filter(
        row =>
          row.amountMicrodollars === -toMicrodollars(49) &&
          row.description === 'App Store Kilo Pass refund clawback'
      )
    ).toHaveLength(1);
    expect(
      negativeCreditTransactions.filter(
        row =>
          row.amountMicrodollars === -toMicrodollars(24.5) &&
          row.description === 'App Store Kilo Pass bonus refund clawback'
      )
    ).toHaveLength(1);
    expect(
      negativeCreditTransactions.filter(
        row =>
          row.amountMicrodollars === -toMicrodollars(12.25) &&
          row.description === 'App Store Kilo Pass promo refund clawback'
      )
    ).toHaveLength(1);
  });

  it('processes a EUR refund without throwing and still ends the subscription', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({
      appAccountToken: user.app_store_account_token,
      currency: 'EUR',
      price: 22900,
    });
    await processAppStoreKiloPassNotification({
      signedPayload: 'eur-refund-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'eur-refund-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription).toBeDefined();

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
    });
    expect(issuance).toBeDefined();

    const [promoTransaction] = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: user.id,
        amount_microdollars: toMicrodollars(4.75),
        is_free: true,
        description: 'test EUR Kilo Pass promo credits',
        credit_category: `test-kilo-pass-promo-eur-${crypto.randomUUID()}`,
      })
      .returning({ id: credit_transactions.id });

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(4.75)}`,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_issuance_items).values({
      kilo_pass_issuance_id: issuance?.id ?? '',
      kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
      credit_transaction_id: promoTransaction?.id ?? '',
      amount_usd: 4.75,
      bonus_percent_applied: 0.25,
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'eur-refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'eur-refund',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'eur-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          ...decodedTransaction,
          revocationDate: 1_777_700_000_000,
          currency: 'EUR',
          price: 22900,
        }),
    });

    expect(result).toEqual({ processed: true });

    const refundEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'eur-refund'),
    });
    expect(refundEvent?.processed_at).not.toBeNull();

    const endedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(endedSubscription?.status).toBe('canceled');

    const negativeCreditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(negativeCreditTransactions.filter(row => row.amountMicrodollars < 0)).toHaveLength(2);
    const eurBaseAmountMicrodollars = toMicrodollars(19);
    expect(negativeCreditTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -eurBaseAmountMicrodollars,
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(4.75),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );
  });

  it('processes a non-USD refund with no recorded purchase amount: still ends subscription and writes processed_at, skips base clawback', async () => {
    const user = await insertTestUser();
    const originalTransactionId = `orig-${crypto.randomUUID()}`;
    const refundTransactionId = `tx-${crypto.randomUUID()}`;

    const [subscriptionRow] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        payment_provider: KiloPassPaymentProvider.AppStore,
        provider_subscription_id: originalTransactionId,
        stripe_subscription_id: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: '2026-05-01T00:00:00.000Z',
        ended_at: null,
      })
      .returning({ id: kilo_pass_subscriptions.id });

    await db.insert(kilo_pass_store_purchases).values({
      kilo_pass_subscription_id: subscriptionRow?.id ?? '',
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.AppStore,
      product_id: 'kilopass.tier19.monthly.v1',
      provider_subscription_id: originalTransactionId,
      provider_transaction_id: refundTransactionId,
      environment: 'Sandbox',
      purchased_at: '2026-05-01T00:00:00.000Z',
      raw_payload_json: {},
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'gbp-no-credit-row-refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'gbp-no-credit-row-refund',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'gbp-no-credit-row-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId,
          transactionId: refundTransactionId,
          appAccountToken: user.app_store_account_token,
          revocationDate: 1_777_700_000_000,
          currency: 'GBP',
          price: 19900,
        }),
    });

    expect(result).toEqual({ processed: true });

    const refundEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'gbp-no-credit-row-refund'),
    });
    expect(refundEvent?.processed_at).not.toBeNull();

    const endedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, originalTransactionId),
    });
    expect(endedSubscription?.status).toBe('canceled');

    const negativeCreditTransactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(negativeCreditTransactions.filter(row => row.amount_microdollars < 0)).toHaveLength(0);
  });

  it.each([
    {
      name: 'missing price',
      refundTransaction: { currency: 'USD', price: undefined },
    },
    {
      name: 'non-finite price',
      refundTransaction: { currency: 'USD', price: Number.POSITIVE_INFINITY },
    },
    {
      name: 'non-positive price',
      refundTransaction: { currency: 'USD', price: 0 },
    },
  ])(
    'reverses the granted base amount regardless of the reported refund price ($name)',
    async ({ name, refundTransaction }) => {
      const user = await insertTestUser();
      const decodedTransaction = transaction({
        appAccountToken: user.app_store_account_token,
      });
      await processAppStoreKiloPassNotification({
        signedPayload: `invalid-refund-initial-buy-${name}`,
        decodeNotification: async () =>
          notification({
            notificationUUID: `invalid-refund-initial-buy-${name}`,
            notificationType: NotificationTypeV2.SUBSCRIBED,
            subtype: Subtype.INITIAL_BUY,
          }),
        decodeTransaction: async () => decodedTransaction,
      });

      const refundNotificationUUID = `invalid-refund-${name}`;
      const result = await processAppStoreKiloPassNotification({
        signedPayload: refundNotificationUUID,
        decodeNotification: async () =>
          notification({
            notificationUUID: refundNotificationUUID,
            notificationType: NotificationTypeV2.REFUND,
            signedTransactionInfo: 'invalid-refund-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            ...decodedTransaction,
            revocationDate: 1_777_700_000_000,
            ...refundTransaction,
          }),
      });

      expect(result).toEqual({ processed: true });

      const negativeCreditTransactions = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, user.id));
      expect(
        negativeCreditTransactions
          .filter(row => row.amount_microdollars < 0)
          .map(row => row.amount_microdollars)
      ).toEqual([-toMicrodollars(19)]);

      const refundEvent = await db.query.kilo_pass_store_events.findFirst({
        where: eq(kilo_pass_store_events.event_id, refundNotificationUUID),
      });
      expect(refundEvent?.processed_at).not.toBeNull();

      const endedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(
          kilo_pass_subscriptions.provider_subscription_id,
          decodedTransaction.originalTransactionId
        ),
      });
      expect(endedSubscription?.status).toBe('canceled');
    }
  );

  it('rolls back credit reversal and processed_at write when markStoreSubscriptionEnded throws', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const notificationUUID = `rollback-refund-${crypto.randomUUID()}`;

    // Seed a subscription + store purchase + promo issuance item
    await processAppStoreKiloPassNotification({
      signedPayload: 'rollback-refund-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: `rollback-refund-initial-buy-${notificationUUID}`,
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: providerTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-05-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-06-01T00:00:00.000Z'),
          currency: 'USD',
          price: 19000,
        }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
    });

    const [promoTransaction] = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: user.id,
        amount_microdollars: toMicrodollars(4.75),
        is_free: true,
        description: 'test promo credits for rollback test',
        credit_category: `test-kilo-pass-promo-rollback-${crypto.randomUUID()}`,
      })
      .returning({ id: credit_transactions.id });

    await db.insert(kilo_pass_issuance_items).values({
      kilo_pass_issuance_id: issuance?.id ?? '',
      kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
      credit_transaction_id: promoTransaction?.id ?? '',
      amount_usd: 4.75,
      bonus_percent_applied: 0.25,
    });

    const failingEndSubscription = jest.fn(async () => {
      throw new Error('simulated DB failure in markStoreSubscriptionEnded');
    });

    // First attempt — should reject because endStoreSubscription throws inside the outer tx
    await expect(
      processAppStoreKiloPassNotification({
        signedPayload: notificationUUID,
        decodeNotification: async () =>
          notification({
            notificationUUID,
            notificationType: NotificationTypeV2.REFUND,
            signedTransactionInfo: 'rollback-refund-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            originalTransactionId: providerSubscriptionId,
            transactionId: providerTransactionId,
            appAccountToken: user.app_store_account_token,
            revocationDate: Date.parse('2026-05-02T00:00:00.000Z'),
            currency: 'USD',
            price: 19000,
          }),
        endStoreSubscription: failingEndSubscription,
      })
    ).rejects.toThrow('simulated DB failure in markStoreSubscriptionEnded');

    // processed_at must be null — the outer tx was rolled back
    const failedEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, notificationUUID),
    });
    expect(failedEvent?.processed_at).toBeNull();

    // No negative credit_transactions exist (rollback succeeded)
    const creditsBefore = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(creditsBefore.filter(row => row.amount_microdollars < 0)).toHaveLength(0);

    // Reset processing_started_at to a stale timestamp to allow retry (simulates processing after the
    // store event claim TTL has elapsed following the first failed attempt)
    await db
      .update(kilo_pass_store_events)
      .set({ processing_started_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(kilo_pass_store_events.event_id, notificationUUID));

    // Second attempt without the override — full success, no duplicates
    const result = await processAppStoreKiloPassNotification({
      signedPayload: notificationUUID,
      decodeNotification: async () =>
        notification({
          notificationUUID,
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'rollback-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: providerTransactionId,
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-02T00:00:00.000Z'),
          currency: 'USD',
          price: 19000,
        }),
    });
    expect(result).toEqual({ processed: true });

    const successEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, notificationUUID),
    });
    expect(successEvent?.processed_at).not.toBeNull();

    // Exactly one set of clawback rows — base + promo, not doubled
    const negativeCreditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    const negatives = negativeCreditTransactions.filter(row => row.amountMicrodollars < 0);
    expect(negatives).toHaveLength(2);
    expect(negatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(19),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(4.75),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );
  });
});

describe('App Store bouncer store events', () => {
  const SIGNED_DATE_MS = 1_777_700_000_000;
  let reportCreditEvent: jest.Mock;

  beforeEach(() => {
    reportCreditEvent = getBouncerClientMock();
    reportCreditEvent.mockClear();
  });

  /**
   * Completes an initial buy for `decodedTransaction`, then adds the bonus and promo credits an
   * issuance carries, so a refund has more than the base credit to claw back.
   */
  async function subscribeWithIssuedCredits(decodedTransaction: AppleStoreDecodedTransaction) {
    const user = await insertTestUser();
    const subscribeTransaction = {
      ...decodedTransaction,
      appAccountToken: user.app_store_account_token,
    };
    await processAppStoreKiloPassNotification({
      signedPayload: `subscribe-${subscribeTransaction.transactionId}`,
      decodeNotification: async () =>
        notification({
          notificationUUID: `subscribe-${subscribeTransaction.transactionId}`,
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => subscribeTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        subscribeTransaction.originalTransactionId
      ),
    });
    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
    });

    const [bonusTransaction, promoTransaction] = await Promise.all([
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(9.5),
          is_free: true,
          description: 'test Kilo Pass bonus credits',
          credit_category: `test-kilo-pass-bonus-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(4.75),
          is_free: true,
          description: 'test Kilo Pass promo credits',
          credit_category: `test-kilo-pass-promo-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
    ]);

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(
          14.25
        )}`,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_issuance_items).values([
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.Bonus,
        credit_transaction_id: bonusTransaction[0]?.id ?? '',
        amount_usd: 9.5,
        bonus_percent_applied: 0.5,
      },
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        credit_transaction_id: promoTransaction[0]?.id ?? '',
        amount_usd: 4.75,
        bonus_percent_applied: 0.25,
      },
    ]);

    const purchased = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    return { user, totalAfterPurchase: purchased?.total_microdollars_acquired ?? 0 };
  }

  function appStoreTransaction(
    decodedTransaction: AppleStoreDecodedTransaction,
    overrides: Partial<AppleStoreDecodedTransaction> = {}
  ): AppleStoreDecodedTransaction {
    return {
      ...decodedTransaction,
      revocationDate: 1_777_700_000_000,
      currency: 'USD',
      price: 24700,
      ...overrides,
    };
  }

  const refund = (
    notificationUUID: string,
    transactionForRefund: AppleStoreDecodedTransaction,
    environment: AppleStoreDecodedNotification['environment'] = 'Sandbox',
    signedDate = SIGNED_DATE_MS
  ) => ({
    signedPayload: notificationUUID,
    decodeNotification: async () =>
      notification({
        notificationUUID,
        notificationType: NotificationTypeV2.REFUND,
        environment,
        signedDate,
      }),
    decodeTransaction: async () => transactionForRefund,
  });

  const refundReversed = (
    notificationUUID: string,
    transactionForReversal: AppleStoreDecodedTransaction,
    environment: AppleStoreDecodedNotification['environment'] = 'Sandbox',
    signedDate = SIGNED_DATE_MS
  ) => ({
    signedPayload: notificationUUID,
    decodeNotification: async () =>
      notification({
        notificationUUID,
        notificationType: NotificationTypeV2.REFUND_REVERSED,
        environment,
        signedDate,
      }),
    decodeTransaction: async () => transactionForReversal,
  });

  it.each<[number | undefined, string]>([
    [1, 'issue'],
    [0, 'other'],
    [undefined, 'other'],
  ])(
    'reports a production refund with revocationReason %s as %s',
    async (revocationReason, reason) => {
      const user = await insertTestUser();
      const notificationUUID = `bouncer-refund-${crypto.randomUUID()}`;
      const decodedTransaction = transaction({
        appAccountToken: user.app_store_account_token,
        revocationReason,
      });

      await processAppStoreKiloPassNotification(
        refund(notificationUUID, decodedTransaction, 'Production')
      );

      expect(reportCreditEvent).toHaveBeenCalledTimes(1);
      expect(reportCreditEvent.mock.calls[0][0]).toEqual({
        type: 'store.refund',
        reason,
        provider: 'apple',
        eventId: notificationUUID,
        occurredAt: new Date(SIGNED_DATE_MS),
        userId: user.id,
        storeAccountKey: decodedTransaction.originalTransactionId,
        referenceId: decodedTransaction.transactionId,
        environment: 'production',
      });
    }
  );

  it('reports a consumption request as a requested refund', async () => {
    const user = await insertTestUser();
    const notificationUUID = `bouncer-consumption-${crypto.randomUUID()}`;
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    const sendConsumptionInformation = jest.fn(async () => undefined);

    await processAppStoreKiloPassNotification({
      signedPayload: notificationUUID,
      sendConsumptionInformation,
      decodeNotification: async () =>
        notification({
          notificationUUID,
          notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
          environment: 'Production',
          signedDate: SIGNED_DATE_MS,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    expect(sendConsumptionInformation).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toEqual({
      type: 'store.refund',
      reason: 'requested',
      provider: 'apple',
      eventId: notificationUUID,
      occurredAt: new Date(SIGNED_DATE_MS),
      userId: user.id,
      storeAccountKey: decodedTransaction.originalTransactionId,
      referenceId: decodedTransaction.transactionId,
      environment: 'production',
    });
  });

  it('reports a production purchase with its USD amount in cents', async () => {
    const user = await insertTestUser();
    const notificationUUID = `bouncer-subscribed-${crypto.randomUUID()}`;
    const decodedTransaction = transaction({
      appAccountToken: user.app_store_account_token,
      currency: 'USD',
      price: 24700,
    });

    await processAppStoreKiloPassNotification({
      signedPayload: notificationUUID,
      decodeNotification: async () =>
        notification({
          notificationUUID,
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
          environment: 'Production',
          signedDate: SIGNED_DATE_MS,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toEqual({
      type: 'store.purchase',
      amountCents: 2470,
      provider: 'apple',
      eventId: notificationUUID,
      occurredAt: new Date(SIGNED_DATE_MS),
      userId: user.id,
      storeAccountKey: decodedTransaction.originalTransactionId,
      referenceId: decodedTransaction.transactionId,
      environment: 'production',
    });
  });

  it('reports a production refund reversal', async () => {
    const user = await insertTestUser();
    const notificationUUID = `bouncer-reversed-${crypto.randomUUID()}`;
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });

    await processAppStoreKiloPassNotification(
      refundReversed(notificationUUID, decodedTransaction, 'Production')
    );

    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toEqual({
      type: 'store.refund_reversed',
      provider: 'apple',
      eventId: notificationUUID,
      occurredAt: new Date(SIGNED_DATE_MS),
      userId: user.id,
      storeAccountKey: decodedTransaction.originalTransactionId,
      referenceId: decodedTransaction.transactionId,
      environment: 'production',
    });
  });

  it('skips a sandbox notification', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({
      appAccountToken: user.app_store_account_token,
      revocationReason: 1,
    });

    await processAppStoreKiloPassNotification(
      refund(`bouncer-sandbox-${crypto.randomUUID()}`, decodedTransaction, 'Sandbox')
    );

    expect(reportCreditEvent).not.toHaveBeenCalled();
  });

  it('skips a production notification that resolves no Kilo user', async () => {
    const decodedTransaction = transaction({ revocationReason: 1 });

    await processAppStoreKiloPassNotification(
      refund(`bouncer-orphan-${crypto.randomUUID()}`, decodedTransaction, 'Production')
    );

    expect(reportCreditEvent).not.toHaveBeenCalled();
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
      revocationDate: SIGNED_DATE_MS,
      revocationType: RevocationType.REFUND_FULL,
      revocationPercentage: 100_000,
    });
    const notificationUUID = `bouncer-credit-pack-${crypto.randomUUID()}`;

    await processAppStoreKiloPassNotification(
      refund(notificationUUID, refundTransaction, 'Production')
    );

    const clawback = await db.query.credit_transactions.findFirst({
      where: eq(
        credit_transactions.credit_category,
        `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${transactionId}`
      ),
    });
    expect(clawback?.amount_microdollars).toBe(-toMicrodollars(10));
    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toMatchObject({
      type: 'store.refund',
      reason: 'other',
      provider: 'apple',
      eventId: notificationUUID,
      userId: user.id,
      referenceId: transactionId,
      environment: 'production',
    });
  });

  it('restores the clawed-back credits and reopens the subscription on a refund reversal', async () => {
    const decodedTransaction = transaction({ currency: 'USD', price: 24700 });
    const { user, totalAfterPurchase } = await subscribeWithIssuedCredits(decodedTransaction);
    const refundTransaction = appStoreTransaction(decodedTransaction, {
      appAccountToken: user.app_store_account_token,
      revocationReason: 1,
    });

    await processAppStoreKiloPassNotification(refund('reversal-refund', refundTransaction));

    const refundedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(refundedUser?.total_microdollars_acquired).toBe(0);
    expect(
      await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(
          kilo_pass_subscriptions.provider_subscription_id,
          decodedTransaction.originalTransactionId
        ),
      })
    ).toMatchObject({ status: 'canceled' });

    const result = await processAppStoreKiloPassNotification(
      refundReversed('reversal', refundTransaction)
    );
    expect(result).toEqual({ processed: true });

    const restoredUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(restoredUser?.total_microdollars_acquired).toBe(totalAfterPurchase);
    expect(
      await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(
          kilo_pass_subscriptions.provider_subscription_id,
          decodedTransaction.originalTransactionId
        ),
      })
    ).toMatchObject({ status: 'active', ended_at: null });

    const rows = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    const clawbacks = rows.filter(row => row.description?.endsWith('refund clawback'));
    const restorations = rows.filter(row => row.description?.endsWith('refund reversal'));
    expect(clawbacks).toHaveLength(3);
    expect(restorations.map(row => row.amountMicrodollars).sort((a, b) => a - b)).toEqual(
      [19, 9.5, 4.75].map(toMicrodollars).sort((a, b) => a - b)
    );
  });

  it('restores the credits once when a refund reversal is redelivered', async () => {
    const decodedTransaction = transaction({ currency: 'USD', price: 24700 });
    const { user, totalAfterPurchase } = await subscribeWithIssuedCredits(decodedTransaction);
    const refundTransaction = appStoreTransaction(decodedTransaction, {
      appAccountToken: user.app_store_account_token,
      revocationReason: 0,
    });

    await processAppStoreKiloPassNotification(refund('replay-refund', refundTransaction));
    await processAppStoreKiloPassNotification(refundReversed('replay', refundTransaction));

    const replayed = await processAppStoreKiloPassNotification(
      refundReversed('replay', refundTransaction)
    );
    expect(replayed).toEqual({ processed: true, status: 'already_processed' });

    // A reversal with a new notification id must not restore the same credits twice either.
    await processAppStoreKiloPassNotification(
      refundReversed(`replay-second-${crypto.randomUUID()}`, refundTransaction)
    );

    const restoredUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(restoredUser?.total_microdollars_acquired).toBe(totalAfterPurchase);

    const rows = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(rows.filter(row => row.description?.endsWith('refund reversal'))).toHaveLength(3);
  });

  it('undoes an older refund that arrives after its newer reversal', async () => {
    const decodedTransaction = transaction({ currency: 'USD', price: 24700 });
    const { user, totalAfterPurchase } = await subscribeWithIssuedCredits(decodedTransaction);
    const refundTransaction = appStoreTransaction(decodedTransaction, {
      appAccountToken: user.app_store_account_token,
      revocationReason: 1,
    });

    const reversalResult = await processAppStoreKiloPassNotification(
      refundReversed('out-of-order-reversal', refundTransaction, 'Sandbox', SIGNED_DATE_MS + 1_000)
    );
    expect(reversalResult).toEqual({ processed: true });

    const afterReversal = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(afterReversal?.total_microdollars_acquired).toBe(totalAfterPurchase);

    await processAppStoreKiloPassNotification(refund('out-of-order-refund', refundTransaction));

    const afterRefund = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(afterRefund?.total_microdollars_acquired).toBe(totalAfterPurchase);
    expect(
      await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(
          kilo_pass_subscriptions.provider_subscription_id,
          decodedTransaction.originalTransactionId
        ),
      })
    ).toMatchObject({ status: 'active', ended_at: null });
  });

  async function readSubscription(originalTransactionId: string) {
    return db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, originalTransactionId),
    });
  }

  async function readTotal(userId: string) {
    const row = await db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, userId) });
    return row?.total_microdollars_acquired;
  }

  it('claws back again and ends the pass when Apple refunds after a reversal', async () => {
    const decodedTransaction = transaction({ currency: 'USD', price: 24700 });
    const { user } = await subscribeWithIssuedCredits(decodedTransaction);
    const refundTransaction = appStoreTransaction(decodedTransaction, {
      appAccountToken: user.app_store_account_token,
    });

    await processAppStoreKiloPassNotification(refund('re-refund-1', refundTransaction));
    await processAppStoreKiloPassNotification(
      refundReversed('re-reversal', refundTransaction, 'Sandbox', SIGNED_DATE_MS + 1_000)
    );
    await processAppStoreKiloPassNotification(
      refund('re-refund-2', refundTransaction, 'Sandbox', SIGNED_DATE_MS + 2_000)
    );

    expect(await readTotal(user.id)).toBe(0);
    expect(await readSubscription(decodedTransaction.originalTransactionId)).toMatchObject({
      status: 'canceled',
    });
  });

  it('grants base credits to a paid resubscribe in the month of a refunded pass', async () => {
    const decodedTransaction = transaction({ currency: 'USD', price: 24700 });
    const { user } = await subscribeWithIssuedCredits(decodedTransaction);
    await processAppStoreKiloPassNotification(
      refund(
        'same-month-refund',
        appStoreTransaction(decodedTransaction, {
          appAccountToken: user.app_store_account_token,
        })
      )
    );
    expect(await readTotal(user.id)).toBe(0);

    // The user pays again later in the same calendar month (after the refund)
    // on the same subscription.
    const resubscribe = transaction({
      originalTransactionId: decodedTransaction.originalTransactionId,
      transactionId: `tx-${crypto.randomUUID()}`,
      appAccountToken: user.app_store_account_token,
      purchaseDate: SIGNED_DATE_MS + 60 * 60_000,
    });
    await processAppStoreKiloPassNotification({
      signedPayload: 'same-month-resubscribe',
      decodeNotification: async () =>
        notification({
          notificationUUID: `resubscribe-${resubscribe.transactionId}`,
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.RESUBSCRIBE,
        }),
      decodeTransaction: async () => resubscribe,
    });

    expect(await readTotal(user.id)).toBe(toMicrodollars(19));
    expect(await readSubscription(decodedTransaction.originalTransactionId)).toMatchObject({
      status: 'active',
    });
  });

  it('does not re-grant a month whose refund Apple reversed', async () => {
    const decodedTransaction = transaction({ currency: 'USD', price: 24700 });
    const { user, totalAfterPurchase } = await subscribeWithIssuedCredits(decodedTransaction);
    const refundTransaction = appStoreTransaction(decodedTransaction, {
      appAccountToken: user.app_store_account_token,
    });
    await processAppStoreKiloPassNotification(refund('reversed-month-refund', refundTransaction));
    await processAppStoreKiloPassNotification(
      refundReversed(
        'reversed-month-reversal',
        refundTransaction,
        'Sandbox',
        SIGNED_DATE_MS + 1_000
      )
    );
    expect(await readTotal(user.id)).toBe(totalAfterPurchase);

    // The month's base credits stand again, so a same-month renewal issues none.
    const renewal = transaction({
      originalTransactionId: decodedTransaction.originalTransactionId,
      transactionId: `tx-${crypto.randomUUID()}`,
      appAccountToken: user.app_store_account_token,
      purchaseDate: SIGNED_DATE_MS + 60 * 60_000,
    });
    await processAppStoreKiloPassNotification({
      signedPayload: 'reversed-month-renewal',
      decodeNotification: async () =>
        notification({
          notificationUUID: `renewal-${renewal.transactionId}`,
          notificationType: NotificationTypeV2.DID_RENEW,
        }),
      decodeTransaction: async () => renewal,
    });

    expect(await readTotal(user.id)).toBe(totalAfterPurchase);
  });

  it('keeps the pass refunded when a reversal older than the refund arrives last', async () => {
    const decodedTransaction = transaction({ currency: 'USD', price: 24700 });
    const { user } = await subscribeWithIssuedCredits(decodedTransaction);
    const refundTransaction = appStoreTransaction(decodedTransaction, {
      appAccountToken: user.app_store_account_token,
    });

    await processAppStoreKiloPassNotification(
      refund('late-reversal-refund', refundTransaction, 'Sandbox', SIGNED_DATE_MS + 2_000)
    );
    await processAppStoreKiloPassNotification(
      refundReversed('late-reversal', refundTransaction, 'Sandbox', SIGNED_DATE_MS + 1_000)
    );

    expect(await readTotal(user.id)).toBe(0);
    expect(await readSubscription(decodedTransaction.originalTransactionId)).toMatchObject({
      status: 'canceled',
    });
  });

  it('restores credits but keeps the pass ended when the user bought another pass meanwhile', async () => {
    const decodedTransaction = transaction({ currency: 'USD', price: 24700 });
    const { user, totalAfterPurchase } = await subscribeWithIssuedCredits(decodedTransaction);
    const refundTransaction = appStoreTransaction(decodedTransaction, {
      appAccountToken: user.app_store_account_token,
    });
    await processAppStoreKiloPassNotification(refund('second-pass-refund', refundTransaction));
    const refunded = await readSubscription(decodedTransaction.originalTransactionId);
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.AppStore,
      provider_subscription_id: `other-original-${crypto.randomUUID()}`,
      tier: refunded?.tier ?? KiloPassTier.Tier19,
      cadence: refunded?.cadence ?? KiloPassCadence.Monthly,
      status: 'active',
    });

    await processAppStoreKiloPassNotification(
      refundReversed('second-pass-reversal', refundTransaction)
    );

    expect(await readTotal(user.id)).toBe(totalAfterPurchase);
    expect(await readSubscription(decodedTransaction.originalTransactionId)).toMatchObject({
      status: 'canceled',
    });
  });
});
