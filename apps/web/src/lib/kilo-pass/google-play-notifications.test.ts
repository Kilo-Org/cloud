import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { and, eq, sql } from 'drizzle-orm';

import {
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilocode_users,
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassCadence,
  KiloPassTier,
  KiloPassIssuanceItemKind,
  KiloPassPaymentProvider,
} from '@/lib/kilo-pass/enums';
import type * as GooglePlayNotifications from './google-play-notifications';
import type * as bouncerClientModule from '@/lib/bouncer/client';
import { toMicrodollars } from '@/lib/microdollars';
import { storeCreditPaymentId } from '@/lib/credits/store-products';
import { googlePlayCreditProviderTransactionId } from '@/lib/credits/store-verifier';
import { completeStoreCreditPurchase } from '@/lib/credits/store-completion';

const mockAcknowledge = jest
  .fn<(...args: unknown[]) => Promise<void>>()
  .mockResolvedValue(undefined);

const mockRevoke = jest.fn<(purchaseToken: string) => Promise<void>>().mockResolvedValue(undefined);

const mockGetGooglePlaySubscriptionPurchase =
  jest.fn<(purchaseToken: string) => Promise<androidpublisher_v3.Schema$SubscriptionPurchaseV2>>();

const mockGetGooglePlaySubscriptionOrder = jest.fn(
  async (orderId: string): Promise<androidpublisher_v3.Schema$Order> => {
    const result = mockGetGooglePlaySubscriptionPurchase.mock.results.at(-1);
    const purchase = result?.type === 'return' ? await result.value : undefined;
    return {
      orderId,
      purchaseToken: mockGetGooglePlaySubscriptionPurchase.mock.calls.at(-1)?.[0],
      state: 'PROCESSED',
      lineItems: purchase?.lineItems?.map(item => ({
        productId: item.productId,
        subscriptionDetails: {
          servicePeriodStartTime: purchase.startTime,
          servicePeriodEndTime: item.expiryTime,
        },
      })),
    };
  }
);

const mockGetGooglePlayProductPurchase = jest.fn(
  async (): Promise<androidpublisher_v3.Schema$ProductPurchase> => ({ purchaseType: undefined })
);

jest.mock('./google-play-sdk', () => ({
  acknowledgeGooglePlaySubscriptionPurchase: mockAcknowledge,
  getGooglePlayProductPurchase: mockGetGooglePlayProductPurchase,
  getGooglePlaySubscriptionPurchase: mockGetGooglePlaySubscriptionPurchase,
  getGooglePlaySubscriptionOrder: mockGetGooglePlaySubscriptionOrder,
  revokeGooglePlaySubscriptionPurchase: mockRevoke,
  GOOGLE_PLAY_PACKAGE_NAME: 'com.kilocode.kiloapp',
}));

// SWC + static ESM imports do not see jest.mock replacements on the same module id.
// Dynamic-import the SUT after the mock (same pattern as apple-store-notifications.test.ts).
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

let processGooglePlayKiloPassNotification: typeof GooglePlayNotifications.processGooglePlayKiloPassNotification;

const GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS = Date.parse('2026-05-15T00:00:00.000Z');

// The mobile clients match this exact backend string, so it is pinned here
// rather than imported from the constant the completion throws it from.
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

function apiData(
  overrides: Partial<androidpublisher_v3.Schema$SubscriptionPurchaseV2> = {}
): androidpublisher_v3.Schema$SubscriptionPurchaseV2 {
  return {
    startTime: '2026-05-01T09:00:00.000Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    lineItems: [
      {
        productId: 'kilopass_tier19',
        expiryTime: '2100-01-01T00:00:00.000Z',
        latestSuccessfulOrderId: `GPA.${crypto.randomUUID()}`,
      },
    ],
    ...overrides,
  };
}

function apiDataForUser(
  obfsAccountId: string,
  orderId = `GPA.${crypto.randomUUID()}`,
  overrides: Partial<androidpublisher_v3.Schema$SubscriptionPurchaseV2> = {}
): androidpublisher_v3.Schema$SubscriptionPurchaseV2 {
  return apiData({
    externalAccountIdentifiers: { obfuscatedExternalAccountId: obfsAccountId },
    lineItems: [
      {
        productId: 'kilopass_tier19',
        expiryTime: '2100-01-01T00:00:00.000Z',
        latestSuccessfulOrderId: orderId,
      },
    ],
    ...overrides,
  });
}

async function insertGooglePlayUser(): Promise<{
  user: Awaited<ReturnType<typeof insertTestUser>>;
  obfsAccountId: string;
}> {
  const obfsAccountId = crypto.randomUUID();
  const user = await insertTestUser({ app_store_account_token: obfsAccountId });
  return { user, obfsAccountId };
}

describe('processGooglePlayKiloPassNotification', () => {
  let dateNowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeAll(async () => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS);
    ({ processGooglePlayKiloPassNotification } = await import('./google-play-notifications'));
  });

  afterAll(() => {
    dateNowSpy.mockRestore();
  });

  beforeEach(() => {
    mockAcknowledge.mockReset().mockResolvedValue(undefined);
    mockRevoke.mockReset().mockResolvedValue(undefined);
    getPosthogTrackingMock().trackKiloPassPurchaseCompleted.mockClear();
    dateNowSpy.mockReturnValue(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS);
    mockGetGooglePlaySubscriptionOrder.mockClear();
    mockGetGooglePlaySubscriptionPurchase.mockReset();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiData());
  });

  it.each([false, true])(
    'keeps deferred entitlement when old expiry arrives first: %s',
    async expiredFirst => {
      const { user, obfsAccountId } = await insertGooglePlayUser();
      const oldToken = crypto.randomUUID();
      const token = crypto.randomUUID();
      const oldOrder = crypto.randomUUID();
      const deferredOrder = crypto.randomUUID();
      const oldItem = {
        productId: 'kilopass_tier19',
        expiryTime: '2026-06-01T00:00:00Z',
        latestSuccessfulOrderId: oldOrder,
      };
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, oldOrder, {
          startTime: '2026-05-01T00:00:00Z',
          lineItems: [oldItem],
        })
      );
      await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({ purchaseToken: oldToken }),
      });
      const expireOld = async () => {
        mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
          apiDataForUser(obfsAccountId, oldOrder, {
            subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
            lineItems: [{ ...oldItem, expiryTime: '2026-05-15T00:00:00Z' }],
          })
        );
        await processGooglePlayKiloPassNotification({
          pubsubMessage: pubsubMessage({ purchaseToken: oldToken, notificationType: 13 }),
        });
      };
      if (expiredFirst) await expireOld();
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, deferredOrder, {
          linkedPurchaseToken: oldToken,
          startTime: '2026-05-15T00:00:00Z',
          acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
          lineItems: [
            { productId: 'kilopass_tier49' },
            {
              ...oldItem,
              latestSuccessfulOrderId: deferredOrder,
              deferredItemReplacement: { productId: 'kilopass_tier49' },
            },
          ],
        })
      );
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
        orderId: deferredOrder,
        purchaseToken: token,
        state: 'PROCESSED',
        lineItems: [{ productId: 'kilopass_tier49' }],
      });
      await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({ purchaseToken: token }),
      });
      if (!expiredFirst) await expireOld();
      const active = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.provider_subscription_id, token),
      });
      expect(active).toMatchObject({ status: 'active', tier: KiloPassTier.Tier19, ended_at: null });
      const unchanged = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(unchanged!.total_microdollars_acquired).toBe(
        user.total_microdollars_acquired + toMicrodollars(19)
      );
      expect(mockAcknowledge).toHaveBeenCalledTimes(1);
      dateNowSpy.mockReturnValue(Date.parse('2026-06-01T00:00:00Z'));
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, undefined, {
          linkedPurchaseToken: oldToken,
          startTime: '2026-06-01T00:00:00Z',
          lineItems: [
            oldItem,
            {
              productId: 'kilopass_tier49',
              expiryTime: '2026-07-01T00:00:00Z',
              latestSuccessfulOrderId: crypto.randomUUID(),
            },
          ],
        })
      );
      await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({ purchaseToken: token, notificationType: 2 }),
      });
      const renewed = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.id, active!.id),
      });
      expect(renewed).toMatchObject({ tier: KiloPassTier.Tier49, current_streak_months: 2 });
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after!.total_microdollars_acquired).toBe(
        user.total_microdollars_acquired + toMicrodollars(68)
      );
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, oldOrder, {
          subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
          lineItems: [oldItem],
        })
      );
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
        orderId: oldOrder,
        purchaseToken: oldToken,
        state: 'REFUNDED',
      });
      await processGooglePlayKiloPassNotification({
        pubsubMessage: {
          messageId: crypto.randomUUID(),
          data: Buffer.from(
            JSON.stringify({
              packageName: 'com.kilocode.kiloapp',
              voidedPurchaseNotification: {
                purchaseToken: oldToken,
                orderId: oldOrder,
                productType: 1,
                refundType: 1,
              },
            })
          ).toString('base64'),
        },
      });
      const refunded = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(refunded!.total_microdollars_acquired).toBe(
        user.total_microdollars_acquired + toMicrodollars(49)
      );
      expect(
        await db.query.kilo_pass_subscriptions.findFirst({
          where: eq(kilo_pass_subscriptions.id, active!.id),
        })
      ).toMatchObject({ status: 'active', tier: KiloPassTier.Tier49 });
    }
  );

  it('completes a purchased notification and tracks google_play', async () => {
    const trackingMock = getPosthogTrackingMock();
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId, orderId));

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-purchased',
        messageId: 'msg-purchased',
      }),
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, 'purchase-token-purchased')
      ),
    });
    expect(subscription).toBeDefined();
    expect(subscription?.status).toBe('active');

    expect(trackingMock.trackKiloPassPurchaseCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'google_play',
        userId: user.id,
        purchaseKind: 'initial',
        providerTransactionId: orderId,
        productId: 'kilopass_tier19',
        environment: 'Production',
      })
    );
  });

  it('reverses a second paid subscription instead of dropping the order', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, `GPA.${crypto.randomUUID()}`)
    );
    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'first-pass-token',
        messageId: 'msg-first-pass',
      }),
    });

    const duplicateOrderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, duplicateOrderId)
    );
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId: duplicateOrderId,
      purchaseToken: 'duplicate-pass-token',
      state: 'PROCESSED',
      total: { currencyCode: 'USD', units: '24', nanos: 700000000 },
      tax: { currencyCode: 'USD' },
      lineItems: [
        {
          productId: 'kilopass_tier19',
          total: { currencyCode: 'USD', units: '24', nanos: 700000000 },
          tax: { currencyCode: 'USD' },
          subscriptionDetails: {
            servicePeriodStartTime: '2026-05-01T09:00:00.000Z',
            servicePeriodEndTime: '2100-01-01T00:00:00.000Z',
          },
        },
      ],
    });

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'duplicate-pass-token',
        messageId: 'msg-duplicate-pass',
      }),
    });

    expect(result).toEqual({ processed: true });
    expect(mockRevoke).toHaveBeenCalledTimes(1);
    expect(mockRevoke).toHaveBeenCalledWith('duplicate-pass-token');

    const duplicatePurchase = await db.query.kilo_pass_store_purchases.findFirst({
      where: eq(kilo_pass_store_purchases.provider_transaction_id, duplicateOrderId),
    });
    expect(duplicatePurchase).toBeUndefined();

    const audit = await db.query.kilo_pass_audit_log.findFirst({
      where: and(
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.StoreSubscriptionRefunded),
        sql`${kilo_pass_audit_log.payload_json}->>'providerTransactionId' = ${duplicateOrderId}`
      ),
    });
    expect(audit).toMatchObject({
      kilo_user_id: user.id,
      result: KiloPassAuditLogResult.Success,
    });
    expect(audit?.payload_json).toMatchObject({
      duplicateActiveSubscription: true,
      amountChargedMinorUnits: 2470,
      currency: 'USD',
      taxMinorUnits: 0,
    });

    const event = await db.query.kilo_pass_store_events.findFirst({
      where: and(
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_events.provider_transaction_id, duplicateOrderId)
      ),
    });
    expect(event?.processed_at).not.toBeNull();
  });

  it('keeps a duplicate purchase unprocessed when the reversal fails', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, `GPA.${crypto.randomUUID()}`)
    );
    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'first-pass-token-fail',
        messageId: 'msg-first-pass-fail',
      }),
    });

    const duplicateOrderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, duplicateOrderId)
    );
    mockRevoke.mockRejectedValueOnce(new Error('play unavailable'));

    await expect(
      processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({
          notificationType: 4,
          purchaseToken: 'duplicate-pass-token-fail',
          messageId: 'msg-duplicate-pass-fail',
        }),
      })
    ).rejects.toThrow('play unavailable');

    const event = await db.query.kilo_pass_store_events.findFirst({
      where: and(
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_events.provider_transaction_id, duplicateOrderId)
      ),
    });
    expect(event?.processed_at).toBeNull();
    const reversalAudit = await db.query.kilo_pass_audit_log.findFirst({
      where: sql`${kilo_pass_audit_log.payload_json}->>'providerTransactionId' = ${duplicateOrderId}`,
    });
    expect(reversalAudit).toBeUndefined();
  });

  it('stores the charged amount, currency and tax from the Play order', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = 'purchase-token-money';
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId, orderId));
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'PROCESSED',
      total: { currencyCode: 'USD', units: '19', nanos: 0 },
      tax: { currencyCode: 'USD', units: '3', nanos: 170000000 },
      lineItems: [
        {
          productId: 'kilopass_tier19',
          total: { currencyCode: 'USD', units: '19', nanos: 0 },
          tax: { currencyCode: 'USD', units: '3', nanos: 170000000 },
          subscriptionDetails: {
            servicePeriodStartTime: '2026-05-01T09:00:00.000Z',
            servicePeriodEndTime: '2100-01-01T00:00:00.000Z',
          },
        },
      ],
    });

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken,
        messageId: 'msg-purchased-money',
      }),
    });

    expect(result).toEqual({ processed: true });

    const purchaseRow = await db.query.kilo_pass_store_purchases.findFirst({
      where: eq(kilo_pass_store_purchases.provider_transaction_id, orderId),
    });
    expect(purchaseRow).toMatchObject({
      kilo_user_id: user.id,
      amount_charged_minor_units: 1900,
      currency: 'USD',
      tax_minor_units: 317,
    });
  });

  it('stores null money for a Play order without money', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId, orderId));

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-no-money',
        messageId: 'msg-purchased-no-money',
      }),
    });

    expect(result).toEqual({ processed: true });

    const purchaseRow = await db.query.kilo_pass_store_purchases.findFirst({
      where: eq(kilo_pass_store_purchases.provider_transaction_id, orderId),
    });
    expect(purchaseRow).toMatchObject({
      amount_charged_minor_units: null,
      currency: null,
      tax_minor_units: null,
    });
  });

  it('completes and stores null money when the Play order amount is negative', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = 'purchase-token-negative-money';
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId, orderId));
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'PROCESSED',
      lineItems: [
        {
          productId: 'kilopass_tier19',
          total: { currencyCode: 'USD', units: '-19', nanos: 0 },
          subscriptionDetails: {
            servicePeriodStartTime: '2026-05-01T09:00:00.000Z',
            servicePeriodEndTime: '2100-01-01T00:00:00.000Z',
          },
        },
      ],
    });

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken,
        messageId: 'msg-purchased-negative-money',
      }),
    });

    // A negative amount cannot satisfy the non-negative check constraint, so it
    // must reach the row as NULL instead of failing the whole purchase.
    expect(result).toEqual({ processed: true });

    const purchaseRow = await db.query.kilo_pass_store_purchases.findFirst({
      where: eq(kilo_pass_store_purchases.provider_transaction_id, orderId),
    });
    expect(purchaseRow).toMatchObject({
      amount_charged_minor_units: null,
      currency: null,
      tax_minor_units: null,
    });
  });

  it('completes a renewed notification as a renewal and tracks google_play', async () => {
    const trackingMock = getPosthogTrackingMock();
    const { obfsAccountId } = await insertGooglePlayUser();
    const initialOrderId = `GPA.${crypto.randomUUID()}`;
    const renewalOrderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, initialOrderId)
    );

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-renewed',
        messageId: 'renewal-initial',
      }),
    });
    trackingMock.trackKiloPassPurchaseCompleted.mockClear();

    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, renewalOrderId)
    );

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 2,
        purchaseToken: 'purchase-token-renewed',
        messageId: 'renewal-2',
      }),
    });

    expect(result).toEqual({ processed: true });
    expect(trackingMock.trackKiloPassPurchaseCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'google_play',
        purchaseKind: 'renewal',
        providerTransactionId: renewalOrderId,
      })
    );
  });

  it.each([
    [1, 'SUBSCRIPTION_STATE_ACTIVE', false],
    [2, 'SUBSCRIPTION_STATE_ACTIVE', false],
    [4, 'SUBSCRIPTION_STATE_ACTIVE', false],
    [7, 'SUBSCRIPTION_STATE_ACTIVE', false],
    [7, 'SUBSCRIPTION_STATE_CANCELED', true],
  ] as const)(
    'reconciles cancellation on event %i with state %s without credit replay',
    async (notificationType, subscriptionState, cancelAtPeriodEnd) => {
      const { user, obfsAccountId } = await insertGooglePlayUser();
      const orderId = `GPA.${crypto.randomUUID()}`;
      const purchaseToken = `restart-${crypto.randomUUID()}`;
      const send = (type: number) =>
        processGooglePlayKiloPassNotification({
          pubsubMessage: pubsubMessage({
            notificationType: type,
            purchaseToken,
            messageId: crypto.randomUUID(),
          }),
        });
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId)
      );
      await send(4);
      const before = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId, {
          subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
        })
      );
      await send(3);
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId, { subscriptionState })
      );
      await send(notificationType);
      const subscription = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.kilo_user_id, user.id),
      });
      expect(subscription?.status).toBe('active');
      expect(subscription?.cancel_at_period_end).toBe(cancelAtPeriodEnd);
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after?.total_microdollars_acquired).toBe(before?.total_microdollars_acquired);
      const purchases = await db.query.kilo_pass_store_purchases.findMany({
        where: eq(kilo_pass_store_purchases.kilo_user_id, user.id),
      });
      expect(purchases).toHaveLength(1);
    }
  );

  it('sets cancel_at_period_end for a canceled notification', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    const orderId = crypto.randomUUID();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId, orderId));

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-canceled',
        messageId: 'cancel-initial',
      }),
    });

    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, orderId, {
        subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
      })
    );

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 3,
        purchaseToken: 'purchase-token-canceled',
        messageId: 'cancel-1',
      }),
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, 'purchase-token-canceled')
      ),
    });
    expect(subscription?.cancel_at_period_end).toBe(true);
    expect(subscription?.status).toBe('active');
  });

  it.each(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'])(
    'reconciles stale cancellation against current state %s',
    async subscriptionState => {
      const { obfsAccountId } = await insertGooglePlayUser();
      const orderId = crypto.randomUUID();
      const token = crypto.randomUUID();
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId)
      );

      await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({
          notificationType: 4,
          purchaseToken: token,
          messageId: crypto.randomUUID(),
        }),
      });

      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId, { subscriptionState })
      );

      const result = await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({
          notificationType: 3,
          purchaseToken: token,
          messageId: crypto.randomUUID(),
        }),
      });

      expect(result).toEqual({ processed: true });

      const subscription = await db.query.kilo_pass_subscriptions.findFirst({
        where: and(
          eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
          eq(kilo_pass_subscriptions.provider_subscription_id, token)
        ),
      });
      expect(subscription?.cancel_at_period_end).toBe(false);
      expect(subscription?.status).toBe('active');
    }
  );

  it('ends the subscription for an expired notification', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId));

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-expired',
        messageId: 'expire-initial',
      }),
    });

    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, undefined, {
        subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
        lineItems: [
          {
            productId: 'kilopass_tier19',
            expiryTime: '2026-05-02T09:00:00.000Z',
            latestSuccessfulOrderId: `GPA.${crypto.randomUUID()}`,
          },
        ],
      })
    );

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 13,
        purchaseToken: 'purchase-token-expired',
        messageId: 'expire-1',
      }),
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, 'purchase-token-expired')
      ),
    });
    expect(subscription?.status).toBe('canceled');
    expect(subscription?.ended_at).not.toBeNull();
    expect(subscription?.cancel_at_period_end).toBe(false);
  });

  it('ignores a stale expiry when Play still reports a future expiry', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId));

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-expire-stale',
        messageId: 'expire-stale-initial',
      }),
    });

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 13,
        purchaseToken: 'purchase-token-expire-stale',
        messageId: 'expire-stale-1',
      }),
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, 'purchase-token-expire-stale')
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.ended_at).toBeNull();
  });

  it('reverses the matched purchase base plus issued bonus and promo credits and ends the subscription', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId));

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-revoked',
        messageId: 'revoke-initial',
      }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, 'purchase-token-revoked')
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

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 12,
        purchaseToken: 'purchase-token-revoked',
        messageId: 'revoke-1',
      }),
    });

    expect(result).toEqual({ processed: true });

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
          description: 'Google Play Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(9.5),
          description: 'Google Play Kilo Pass bonus refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(4.75),
          description: 'Google Play Kilo Pass promo refund clawback',
        }),
      ])
    );

    const endedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, 'purchase-token-revoked'),
    });
    expect(endedSubscription?.status).toBe('canceled');
    expect(endedSubscription?.ended_at).not.toBeNull();
    expect(endedSubscription?.cancel_at_period_end).toBe(false);
  });

  it('does not claw back a different order when the revoked order was never granted', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const token = crypto.randomUUID();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, 'paid-order')
    );
    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({ purchaseToken: token, messageId: crypto.randomUUID() }),
    });
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, 'ungranted-order', {
        subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
      })
    );
    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        purchaseToken: token,
        notificationType: 12,
        messageId: crypto.randomUUID(),
      }),
    });
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after!.total_microdollars_acquired).toBe(
      user.total_microdollars_acquired + toMicrodollars(19)
    );
  });

  it.each([false, true])(
    'reverses a refund-only order once and blocks later bonus (bonusIssued=%s)',
    async bonusIssued => {
      const { user, obfsAccountId } = await insertGooglePlayUser();
      const token = crypto.randomUUID();
      const orderId = crypto.randomUUID();
      const now = new Date();
      dateNowSpy.mockReturnValue(now.valueOf());
      const purchase = apiDataForUser(obfsAccountId, orderId, { startTime: now.toISOString() });
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(purchase);
      await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({ purchaseToken: token, messageId: crypto.randomUUID() }),
      });
      const paid = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      await db
        .update(kilocode_users)
        .set({ microdollars_used: paid!.kilo_pass_threshold! })
        .where(eq(kilocode_users.id, user.id));
      const { maybeIssueKiloPassBonusFromUsageThreshold } =
        await import('@/lib/kilo-pass/usage-triggered-bonus');
      const issue = () =>
        maybeIssueKiloPassBonusFromUsageThreshold({
          kiloUserId: user.id,
          nowIso: now.toISOString(),
        });
      if (bonusIssued) await issue();
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
        orderId,
        purchaseToken: token,
        state: 'REFUNDED',
      });
      const message = {
        messageId: crypto.randomUUID(),
        data: Buffer.from(
          JSON.stringify({
            packageName: 'com.kilocode.kiloapp',
            eventTimeMillis: String(now.valueOf()),
            voidedPurchaseNotification: {
              purchaseToken: token,
              orderId,
              productType: 1,
              refundType: 1,
            },
          })
        ).toString('base64'),
      };
      await processGooglePlayKiloPassNotification({ pubsubMessage: message });
      await issue();
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
        orderId,
        purchaseToken: token,
        state: 'REFUNDED',
      });
      await expect(
        processGooglePlayKiloPassNotification({
          pubsubMessage: pubsubMessage({ purchaseToken: token, messageId: crypto.randomUUID() }),
        })
      ).resolves.toEqual({ processed: true });
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
        orderId,
        purchaseToken: token,
        state: 'REFUNDED',
      });
      await processGooglePlayKiloPassNotification({
        pubsubMessage: { ...message, messageId: crypto.randomUUID() },
      });
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after!.total_microdollars_acquired).toBe(user.total_microdollars_acquired);
      expect(after!.kilo_pass_threshold).toBeNull();
      const subscription = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.provider_subscription_id, token),
      });
      expect(subscription!.status).toBe('active');
    }
  );

  it.each([{ state: 'PROCESSED' }, { orderId: 'wrong-order' }, { purchaseToken: 'wrong-token' }])(
    'rejects unverified refund %j without a credit change',
    async overrides => {
      const { user } = await insertGooglePlayUser();
      const orderId = crypto.randomUUID();
      const purchaseToken = crypto.randomUUID();
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
        orderId,
        purchaseToken,
        state: 'REFUNDED',
        ...overrides,
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
                  productType: 1,
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
    }
  );

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
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce(order);
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
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce(order);
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
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
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
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
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
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
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
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
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
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce(order);
      await processGooglePlayKiloPassNotification({
        pubsubMessage: voidedMessage({ orderId, purchaseToken, refundType: 1 }),
      });
      await db
        .update(kilocode_users)
        .set({ microdollars_used: toMicrodollars(4) })
        .where(eq(kilocode_users.id, user.id));

      // A new message id bypasses the event claim, so only the reversal's own
      // idempotency key protects the stored amount.
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce(order);
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

    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
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
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
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

  it.each([false, true])(
    'acknowledges committed credits and retries without another grant (resubscription: %s)',
    async resubscription => {
      const { user, obfsAccountId } = await insertGooglePlayUser();
      const token = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, undefined, {
          acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
          ...(resubscription
            ? {
                externalAccountIdentifiers: undefined,
                outOfAppPurchaseContext: {
                  expiredExternalAccountIdentifiers: { obfuscatedExternalAccountId: obfsAccountId },
                },
              }
            : {}),
        })
      );
      mockAcknowledge.mockImplementationOnce(async () => {
        const granted = await db.query.kilocode_users.findFirst({
          where: eq(kilocode_users.id, user.id),
        });
        expect(granted!.total_microdollars_acquired).toBe(
          user.total_microdollars_acquired + toMicrodollars(19)
        );
        throw new Error('acknowledgement unavailable');
      });
      const message = pubsubMessage({ purchaseToken: token, messageId });
      await expect(
        processGooglePlayKiloPassNotification({ pubsubMessage: message })
      ).rejects.toThrow('acknowledgement unavailable');
      const pending = await db.query.kilo_pass_store_events.findFirst({
        where: eq(kilo_pass_store_events.event_id, messageId),
      });
      expect(pending!.processed_at).toBeNull();
      await db
        .update(kilo_pass_store_events)
        .set({ processing_started_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() })
        .where(eq(kilo_pass_store_events.id, pending!.id));
      await expect(
        processGooglePlayKiloPassNotification({ pubsubMessage: message })
      ).resolves.toEqual({ processed: true });
      expect(mockAcknowledge).toHaveBeenCalledTimes(2);
      expect(mockAcknowledge).toHaveBeenLastCalledWith(
        'kilopass_tier19',
        token,
        resubscription ? obfsAccountId : undefined
      );
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after!.total_microdollars_acquired).toBe(
        user.total_microdollars_acquired + toMicrodollars(19)
      );
    }
  );

  it('preserves the current paid period and bonus when an older order is voided', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const token = crypto.randomUUID();
    const orders = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, start, end] of [
      [0, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'],
      [1, '2026-07-01T00:00:00Z', '2100-01-01T00:00:00Z'],
    ] as const) {
      dateNowSpy.mockReturnValue(Date.parse(start));
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orders[index], {
          startTime: '2026-06-01T00:00:00Z',
          lineItems: [
            {
              productId: 'kilopass_tier19',
              latestSuccessfulOrderId: orders[index],
              expiryTime: end,
            },
          ],
        })
      );
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
        orderId: orders[index],
        purchaseToken: token,
        state: 'PROCESSED',
        lineItems: [
          {
            productId: 'kilopass_tier19',
            subscriptionDetails: { servicePeriodStartTime: start, servicePeriodEndTime: end },
          },
        ],
      });
      await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({
          purchaseToken: token,
          notificationType: index === 0 ? 4 : 2,
          messageId: crypto.randomUUID(),
        }),
      });
    }
    const before = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(before!.total_microdollars_acquired).toBe(
      user.total_microdollars_acquired + toMicrodollars(38)
    );
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId: orders[0],
      purchaseToken: token,
      state: 'REFUNDED',
    });
    await processGooglePlayKiloPassNotification({
      pubsubMessage: {
        messageId: crypto.randomUUID(),
        data: Buffer.from(
          JSON.stringify({
            packageName: 'com.kilocode.kiloapp',
            eventTimeMillis: String(Date.now()),
            voidedPurchaseNotification: {
              purchaseToken: token,
              orderId: orders[0],
              productType: 1,
              refundType: 1,
            },
          })
        ).toString('base64'),
      },
    });
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after!.total_microdollars_acquired).toBe(
      user.total_microdollars_acquired + toMicrodollars(19)
    );
    expect(after!.kilo_pass_threshold).toBe(before!.kilo_pass_threshold);
    await db
      .update(kilocode_users)
      .set({ microdollars_used: after!.kilo_pass_threshold! })
      .where(eq(kilocode_users.id, user.id));
    const { maybeIssueKiloPassBonusFromUsageThreshold } =
      await import('@/lib/kilo-pass/usage-triggered-bonus');
    const issue = () =>
      maybeIssueKiloPassBonusFromUsageThreshold({
        kiloUserId: user.id,
        nowIso: '2026-07-15T00:00:00Z',
      });
    await issue();
    const withBonus = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(withBonus!.total_microdollars_acquired).toBeGreaterThan(
      after!.total_microdollars_acquired
    );
    await issue();
    const duplicate = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(duplicate!.total_microdollars_acquired).toBe(withBonus!.total_microdollars_acquired);
    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, token),
    });
    expect(subscription!.status).toBe('active');
  });

  it('returns already_processed for a duplicate messageId', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId));

    const params = {
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-duplicate',
        messageId: 'msg-duplicate',
      }),
    };

    await processGooglePlayKiloPassNotification(params);
    const replay = await processGooglePlayKiloPassNotification(params);

    expect(replay).toEqual({ processed: true, status: 'already_processed' });
  });

  it('returns in_flight for a fresh in-flight duplicate delivery', async () => {
    await db.insert(kilo_pass_store_events).values({
      payment_provider: KiloPassPaymentProvider.GooglePlay,
      event_id: 'msg-inflight',
      provider_subscription_id: 'purchase-token-inflight',
      provider_transaction_id: 'GPA.1234',
      app_account_token: crypto.randomUUID(),
      product_id: 'kilopass_tier19',
      environment: 'Production',
      payload_json: {
        notificationType: 4,
        eventTimeMillis: GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS,
      },
      processing_started_at: new Date().toISOString(),
      processed_at: null,
    });

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-inflight',
        messageId: 'msg-inflight',
      }),
    });

    expect(result).toEqual({ processed: false, status: 'in_flight' });
  });

  it('throws on a package mismatch', async () => {
    await expect(
      processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({
          packageName: 'com.other.app',
          notificationType: 4,
          purchaseToken: 'purchase-token-package',
        }),
      })
    ).rejects.toThrow('Google Play notification package mismatch');
  });

  it('marks a purchased notification processed when no user exists', async () => {
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(crypto.randomUUID()));

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-no-user',
        messageId: 'msg-no-user',
      }),
    });

    expect(result).toEqual({ processed: true });

    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'msg-no-user'),
    });
    expect(event?.processed_at).not.toBeNull();

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(
        and(
          eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
          eq(kilo_pass_subscriptions.provider_subscription_id, 'purchase-token-no-user')
        )
      );
    expect(subscriptions).toHaveLength(0);
  });

  it('throws for a renewal notification without a user', async () => {
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(crypto.randomUUID()));

    await expect(
      processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({
          notificationType: 2,
          purchaseToken: 'purchase-token-renewal-no-user',
          messageId: 'msg-renewal-no-user',
        }),
      })
    ).rejects.toThrow(
      'Google Play renewal notification cannot create a subscription without a user'
    );
  });

  it('skips completion when a processed revoked event for the same purchase token exists', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId));

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-terminal',
        messageId: 'terminal-initial',
      }),
    });

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 12,
        purchaseToken: 'purchase-token-terminal',
        messageId: 'terminal-revoked',
      }),
    });

    const delayedOrderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, delayedOrderId, {
        startTime: '2026-05-10T09:00:00.000Z',
      })
    );

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 2,
        purchaseToken: 'purchase-token-terminal',
        messageId: 'terminal-delayed-renewal',
      }),
    });

    expect(result).toEqual({ processed: true });

    const delayedStorePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.provider_transaction_id, delayedOrderId));
    expect(delayedStorePurchases).toHaveLength(0);

    const userCreditTransactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    // Base + reversed base only: the delayed renewal issued nothing new.
    expect(userCreditTransactions.filter(row => row.amount_microdollars > 0)).toHaveLength(1);
  });
  it.each([
    [19, '2026-05-01T09:00:00.000Z', '2026-06-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z'],
    [49, '2026-01-31T09:00:00.000Z', '2026-02-28T09:00:00.000Z', '2026-03-28T09:00:00.000Z'],
    [199, '2025-12-31T09:00:00.000Z', '2026-01-31T09:00:00.000Z', '2026-02-28T09:00:00.000Z'],
    [19, '2024-01-31T09:00:00.000Z', '2024-02-29T09:00:00.000Z', '2024-03-29T09:00:00.000Z'],
  ] as const)(
    'issues tier %i credits across paid month %s to %s',
    async (tier, initial, renewal, end) => {
      const { user, obfsAccountId } = await insertGooglePlayUser();
      const token = `parity-review-${crypto.randomUUID()}`;
      for (const [index, now, expiry] of [
        [0, initial, renewal],
        [1, renewal, end],
      ] as const) {
        dateNowSpy.mockReturnValue(Date.parse(now));
        mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
          apiDataForUser(obfsAccountId, `${token}-order-${index}`, {
            startTime: initial,
            lineItems: [
              {
                productId: `kilopass_tier${tier}`,
                expiryTime: expiry,
                latestSuccessfulOrderId: `${token}-order-${index}`,
              },
            ],
          })
        );
        mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
          orderId: `${token}-order-${index}`,
          purchaseToken: token,
          state: 'PROCESSED',
          lineItems: [
            {
              productId: `kilopass_tier${tier}`,
              subscriptionDetails: { servicePeriodStartTime: now, servicePeriodEndTime: expiry },
            },
          ],
        });
        await processGooglePlayKiloPassNotification({
          pubsubMessage: pubsubMessage({
            notificationType: index === 0 ? 4 : 2,
            purchaseToken: token,
            messageId: `${token}-event-${index}`,
            eventTimeMillis: String(Date.parse(now)),
          }),
        });
      }
      const sub = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.kilo_user_id, user.id),
      });
      const issuances = await db.query.kilo_pass_issuances.findMany({
        where: eq(kilo_pass_issuances.kilo_pass_subscription_id, sub!.id),
      });
      const refreshed = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      console.log(
        'PARITY_REVIEW',
        JSON.stringify({
          months: issuances.map(x => x.issue_month),
          streak: sub?.current_streak_months,
          credits: refreshed!.total_microdollars_acquired - user.total_microdollars_acquired,
        })
      );
      expect(issuances).toHaveLength(2);
      expect(sub?.current_streak_months).toBe(2);
      expect(refreshed!.total_microdollars_acquired - user.total_microdollars_acquired).toBe(
        toMicrodollars(tier * 2)
      );
    }
  );
  it('preserves the Play grace-period expiry for account state', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    const token = 'parity-grace-token';
    const order = 'parity-grace-order';
    dateNowSpy.mockReturnValue(Date.parse('2026-05-01T09:00:00.000Z'));
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, order, {
        lineItems: [
          {
            productId: 'kilopass_tier19',
            latestSuccessfulOrderId: order,
            expiryTime: '2026-06-01T09:00:00.000Z',
          },
        ],
      })
    );
    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        purchaseToken: token,
        messageId: 'parity-grace-initial',
        notificationType: 4,
      }),
    });
    dateNowSpy.mockReturnValue(Date.parse('2026-06-02T09:00:00.000Z'));
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, order, {
        subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        lineItems: [
          {
            productId: 'kilopass_tier19',
            latestSuccessfulOrderId: order,
            expiryTime: '2026-06-08T09:00:00.000Z',
          },
        ],
      })
    );
    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        purchaseToken: token,
        messageId: 'parity-grace-event',
        notificationType: 6,
      }),
    });
    const purchase = await db.query.kilo_pass_store_purchases.findFirst({
      where: eq(kilo_pass_store_purchases.provider_subscription_id, token),
    });
    expect(new Date(purchase!.expires_at!).toISOString()).toBe('2026-06-08T09:00:00.000Z');
  });
  it.each([
    [5, 'SUBSCRIPTION_STATE_ON_HOLD', 'past_due'],
    [6, 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'active'],
    [9, 'SUBSCRIPTION_STATE_ACTIVE', 'active'],
    [10, 'SUBSCRIPTION_STATE_PAUSED', 'paused'],
    [11, 'SUBSCRIPTION_STATE_PAUSED', 'paused'],
  ] as const)(
    'reconciles event %i and recovers the same order without credits',
    async (type, state, expected) => {
      const { user, obfsAccountId } = await insertGooglePlayUser();
      const token = crypto.randomUUID();
      const orderId = crypto.randomUUID();
      const send = (notificationType: number) =>
        processGooglePlayKiloPassNotification({
          pubsubMessage: pubsubMessage({
            notificationType,
            purchaseToken: token,
            messageId: crypto.randomUUID(),
          }),
        });
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId)
      );
      await send(4);
      const before = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId, { subscriptionState: state })
      );
      await send(type);
      const paused = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.kilo_user_id, user.id),
      });
      expect(paused?.status).toBe(expected);
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId)
      );
      await send(1);
      const recovered = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.kilo_user_id, user.id),
      });
      expect(recovered?.status).toBe('active');
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after?.total_microdollars_acquired).toBe(before?.total_microdollars_acquired);
      expect(
        await db.query.kilo_pass_store_purchases.findMany({
          where: eq(kilo_pass_store_purchases.kilo_user_id, user.id),
        })
      ).toHaveLength(1);
    }
  );

  it('does not grant credits after an order lookup fails and completes one stale retry', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const orderId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId, orderId));
    mockGetGooglePlaySubscriptionOrder.mockRejectedValueOnce(new Error('provider unavailable'));
    const message = pubsubMessage({ purchaseToken: token, messageId });
    await expect(processGooglePlayKiloPassNotification({ pubsubMessage: message })).rejects.toThrow(
      'provider unavailable'
    );
    expect(
      await db.query.kilo_pass_store_purchases.findMany({
        where: eq(kilo_pass_store_purchases.kilo_user_id, user.id),
      })
    ).toHaveLength(0);
    await db
      .update(kilo_pass_store_events)
      .set({ processing_started_at: '2026-05-01T00:00:00Z' })
      .where(eq(kilo_pass_store_events.event_id, messageId));
    await expect(
      processGooglePlayKiloPassNotification({ pubsubMessage: message })
    ).resolves.toEqual({ processed: true });
    await expect(
      processGooglePlayKiloPassNotification({ pubsubMessage: message })
    ).resolves.toEqual({ processed: true, status: 'already_processed' });
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after!.total_microdollars_acquired - user.total_microdollars_acquired).toBe(
      toMicrodollars(19)
    );
  });
  it.each([
    [19, false, false],
    [49, false, false],
    [199, false, false],
    [19, true, false],
    [49, true, false],
    [199, true, false],
    [19, false, true],
    [49, false, true],
    [199, false, true],
    [19, true, true],
    [49, true, true],
    [199, true, true],
  ] as const)(
    'grants tier %i bonus once and refunds spent credits (returning=%s, canceled=%s)',
    async (tier, returning, canceled) => {
      const { user, obfsAccountId } = await insertGooglePlayUser();
      if (returning)
        await db.insert(kilo_pass_subscriptions).values({
          kilo_user_id: user.id,
          payment_provider: KiloPassPaymentProvider.AppStore,
          provider_subscription_id: crypto.randomUUID(),
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
          status: 'canceled',
          ended_at: '2025-01-01T00:00:00Z',
        });
      const now = new Date();
      dateNowSpy.mockReturnValue(now.valueOf());
      const start = now.toISOString();
      const end = new Date(now.valueOf() + 31 * 86400000).toISOString();
      const token = crypto.randomUUID();
      const orderId = crypto.randomUUID();
      const live = apiDataForUser(obfsAccountId, orderId, {
        startTime: start,
        lineItems: [
          {
            productId: `kilopass_tier${tier}`,
            latestSuccessfulOrderId: orderId,
            expiryTime: end,
          },
        ],
      });
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(live);
      const send = (notificationType: number, messageId: string) =>
        processGooglePlayKiloPassNotification({
          pubsubMessage: pubsubMessage({ purchaseToken: token, messageId, notificationType }),
        });
      await send(4, crypto.randomUUID());
      const paid = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(paid!.total_microdollars_acquired - user.total_microdollars_acquired).toBe(
        toMicrodollars(tier)
      );
      const threshold = paid!.kilo_pass_threshold! - toMicrodollars(1);
      if (canceled) {
        mockGetGooglePlaySubscriptionPurchase.mockResolvedValue({
          ...live,
          subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
        });
        await send(3, crypto.randomUUID());
        const pendingCancel = await db.query.kilo_pass_subscriptions.findFirst({
          where: eq(kilo_pass_subscriptions.provider_subscription_id, token),
        });
        expect(pendingCancel?.status).toBe('active');
        expect(pendingCancel?.cancel_at_period_end).toBe(true);
      }
      const { maybeIssueKiloPassBonusFromUsageThreshold } =
        await import('@/lib/kilo-pass/usage-triggered-bonus');
      const issue = () =>
        maybeIssueKiloPassBonusFromUsageThreshold({ kiloUserId: user.id, nowIso: start });
      await db
        .update(kilocode_users)
        .set({ microdollars_used: threshold - 1 })
        .where(eq(kilocode_users.id, user.id));
      await issue();
      const below = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(below!.total_microdollars_acquired).toBe(paid!.total_microdollars_acquired);
      await db
        .update(kilocode_users)
        .set({ microdollars_used: threshold })
        .where(eq(kilocode_users.id, user.id));
      await Promise.all([issue(), issue()]);
      const bonus = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      const bonusUsd = tier * (returning ? 0.05 : 0.5);
      expect(bonus!.total_microdollars_acquired - paid!.total_microdollars_acquired).toBe(
        toMicrodollars(bonusUsd)
      );
      expect(bonus!.kilo_pass_threshold).toBeNull();
      // Artificial usage must not reduce the refund or erase the spending history.
      const spent = bonus!.total_microdollars_acquired;
      await db
        .update(kilocode_users)
        .set({ microdollars_used: spent })
        .where(eq(kilocode_users.id, user.id));
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue({
        ...live,
        subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
        lineItems: [
          { ...live.lineItems![0], expiryTime: new Date(now.valueOf() - 1).toISOString() },
        ],
      });
      const refundId = crypto.randomUUID();
      await send(12, refundId);
      await send(12, refundId);
      await send(12, crypto.randomUUID());
      const refunded = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(refunded!.total_microdollars_acquired).toBe(user.total_microdollars_acquired);
      expect(refunded!.microdollars_used).toBe(spent);
      expect(refunded!.total_microdollars_acquired - refunded!.microdollars_used).toBe(
        -toMicrodollars(tier + bonusUsd)
      );
      await issue();
      const afterRefundCheck = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(afterRefundCheck!.total_microdollars_acquired).toBe(
        refunded!.total_microdollars_acquired
      );
      const sub = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.provider_subscription_id, token),
      });
      expect(sub!.status).toBe('canceled');
    }
  );
  it.each(['SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_PAUSED'])(
    'uses live %s state for a delayed renewal without issuing credits',
    async subscriptionState => {
      const { user, obfsAccountId } = await insertGooglePlayUser();
      const token = crypto.randomUUID();
      const orderId = crypto.randomUUID();
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId)
      );
      await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({ purchaseToken: token, messageId: crypto.randomUUID() }),
      });
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, orderId, { subscriptionState })
      );
      await expect(
        processGooglePlayKiloPassNotification({
          pubsubMessage: pubsubMessage({
            purchaseToken: token,
            messageId: crypto.randomUUID(),
            notificationType: 2,
          }),
        })
      ).resolves.toEqual({ processed: true });
      const after = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(after!.total_microdollars_acquired - user.total_microdollars_acquired).toBe(
        toMicrodollars(19)
      );
      const sub = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.provider_subscription_id, token),
      });
      expect(sub!.status).toBe(
        subscriptionState === 'SUBSCRIPTION_STATE_PAUSED' ? 'paused' : 'past_due'
      );
    }
  );

  it('settles concurrent messages for one paid order with one credit grant', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const token = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId, orderId));
    await Promise.all(
      [1, 2].map(() =>
        processGooglePlayKiloPassNotification({
          pubsubMessage: pubsubMessage({ purchaseToken: token, messageId: crypto.randomUUID() }),
        })
      )
    );
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after!.total_microdollars_acquired - user.total_microdollars_acquired).toBe(
      toMicrodollars(19)
    );
    expect(
      await db.query.kilo_pass_store_purchases.findMany({
        where: eq(kilo_pass_store_purchases.kilo_user_id, user.id),
      })
    ).toHaveLength(1);
  });
});

describe('Google Play bouncer store events', () => {
  let reportCreditEvent: jest.Mock;

  beforeEach(() => {
    reportCreditEvent = getBouncerClientMock();
    reportCreditEvent.mockClear();
  });

  /** Completes one paid purchase so the subscription resolves to `accountId`. */
  async function subscribe(token: string, orderId: string, accountId: string) {
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(accountId, orderId));
    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: token,
        messageId: `setup-${token}`,
      }),
    });
    reportCreditEvent.mockClear();
  }

  function voidedMessage(messageId: string, purchaseToken: string, orderId: string) {
    return {
      messageId,
      data: Buffer.from(
        JSON.stringify({
          packageName: 'com.kilocode.kiloapp',
          eventTimeMillis: String(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS),
          voidedPurchaseNotification: { purchaseToken, orderId, productType: 1, refundType: 1 },
        })
      ).toString('base64'),
    };
  }

  it('reports a voided purchase as an other-reason refund', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const token = `void-token-${crypto.randomUUID()}`;
    const orderId = `GPA.${crypto.randomUUID()}`;
    await subscribe(token, orderId, obfsAccountId);
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken: token,
      state: 'REFUNDED',
    });

    await processGooglePlayKiloPassNotification({
      pubsubMessage: voidedMessage('void-report', token, orderId),
    });

    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toEqual({
      type: 'store.refund',
      reason: 'other',
      provider: 'google',
      eventId: 'void-report',
      occurredAt: new Date(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS),
      userId: user.id,
      referenceId: orderId,
      environment: 'production',
    });
  });

  it('grants base credits to a same-month renewal after the refunded order', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const token = `refund-renew-token-${crypto.randomUUID()}`;
    const refundedOrderId = `GPA.${crypto.randomUUID()}`;
    await subscribe(token, refundedOrderId, obfsAccountId);
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId: refundedOrderId,
      purchaseToken: token,
      state: 'REFUNDED',
    });
    await processGooglePlayKiloPassNotification({
      pubsubMessage: voidedMessage('refund-before-renew', token, refundedOrderId),
    });
    const afterRefund = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(afterRefund!.total_microdollars_acquired).toBe(0);

    // Play charges a new order on the same subscription in the same month.
    const renewedOrderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, renewedOrderId)
    );
    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 2,
        purchaseToken: token,
        messageId: `renew-${renewedOrderId}`,
      }),
    });

    const afterRenewal = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(afterRenewal!.total_microdollars_acquired).toBe(toMicrodollars(19));
  });

  it('reports a production purchase with its USD amount in cents', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const token = `purchase-token-${crypto.randomUUID()}`;
    const orderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId, orderId));
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken: token,
      state: 'PROCESSED',
      lineItems: [
        {
          productId: 'kilopass_tier19',
          total: { currencyCode: 'USD', units: '19', nanos: 0 },
          subscriptionDetails: {
            servicePeriodStartTime: '2026-05-01T09:00:00.000Z',
            servicePeriodEndTime: '2100-01-01T00:00:00.000Z',
          },
        },
      ],
    });

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: token,
        messageId: 'purchase-report',
      }),
    });

    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toEqual({
      type: 'store.purchase',
      amountCents: 1900,
      provider: 'google',
      eventId: 'purchase-report',
      occurredAt: new Date(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS),
      userId: user.id,
      referenceId: orderId,
      environment: 'production',
    });
  });

  it('reports a production revoked subscription', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const token = `revoked-token-${crypto.randomUUID()}`;
    const orderId = `GPA.${crypto.randomUUID()}`;
    await subscribe(token, orderId, obfsAccountId);

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 12,
        purchaseToken: token,
        messageId: 'revoked-report',
      }),
    });

    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toEqual({
      type: 'store.revoked',
      provider: 'google',
      eventId: 'revoked-report',
      occurredAt: new Date(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS),
      userId: user.id,
      referenceId: orderId,
      environment: 'production',
    });
  });

  it("does not flag the owner when Play revokes an order Kilo never admitted (Kilo's duplicate reversal)", async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    const token = `owned-token-${crypto.randomUUID()}`;
    await subscribe(token, `GPA.${crypto.randomUUID()}`, obfsAccountId);
    // The revoked order is not the admitted one: Kilo refunded and revoked a duplicate purchase.
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, `GPA.${crypto.randomUUID()}`)
    );

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 12,
        purchaseToken: token,
        messageId: 'duplicate-revoked-report',
      }),
    });

    expect(reportCreditEvent).not.toHaveBeenCalled();
  });

  it('skips a sandbox notification', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    const token = `sandbox-token-${crypto.randomUUID()}`;
    const orderId = `GPA.${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, orderId, { testPurchase: {} })
    );

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 12,
        purchaseToken: token,
        messageId: 'sandbox-report',
      }),
    });

    expect(reportCreditEvent).not.toHaveBeenCalled();
  });

  it('skips a production notification that resolves no Kilo user', async () => {
    const token = `orphan-token-${crypto.randomUUID()}`;
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiData());

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 12,
        purchaseToken: token,
        messageId: 'orphan-report',
      }),
    });

    expect(reportCreditEvent).not.toHaveBeenCalled();
  });

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
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd10' }],
    });

    await processGooglePlayKiloPassNotification({
      pubsubMessage: voidedCreditPackMessage('credit-pack-void', purchaseToken, orderId),
    });

    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toEqual({
      type: 'store.refund',
      reason: 'other',
      provider: 'google',
      eventId: expect.any(String),
      occurredAt: new Date(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS),
      userId: user.id,
      referenceId: orderId,
      environment: 'production',
    });
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
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
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
    expect(reportCreditEvent).not.toHaveBeenCalled();
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
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
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

    expect(reportCreditEvent).toHaveBeenCalledTimes(1);
    expect(reportCreditEvent.mock.calls[0][0]).toMatchObject({
      type: 'store.refund',
      userId: user.id,
      referenceId: orderId,
      environment: 'production',
    });
  });

  it('reports nothing for a refunded credit pack Kilo never granted', async () => {
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
      orderId,
      purchaseToken,
      state: 'REFUNDED',
      lineItems: [{ productId: 'credits_usd10' }],
    });

    await processGooglePlayKiloPassNotification({
      pubsubMessage: voidedCreditPackMessage('credit-pack-void-ungranted', purchaseToken, orderId),
    });

    expect(reportCreditEvent).not.toHaveBeenCalled();
  });
});
