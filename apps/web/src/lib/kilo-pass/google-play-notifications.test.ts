import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';
import { and, eq, sql } from 'drizzle-orm';

import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilocode_users,
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { KiloPassIssuanceItemKind, KiloPassPaymentProvider } from './enums';
import type * as GooglePlayNotifications from './google-play-notifications';
import { toMicrodollars } from '@/lib/utils';

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

jest.mock('./google-play-sdk', () => ({
  getGooglePlaySubscriptionPurchase: mockGetGooglePlaySubscriptionPurchase,
  getGooglePlaySubscriptionOrder: mockGetGooglePlaySubscriptionOrder,
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

type PosthogTrackingMock = {
  trackKiloPassPurchaseCompleted: jest.Mock;
  runAfterResponse: (work: () => Promise<void>) => Promise<void>;
};

function getPosthogTrackingMock(): PosthogTrackingMock {
  return jest.requireMock('@/lib/kilo-pass/posthog-tracking') as PosthogTrackingMock;
}

let processGooglePlayKiloPassNotification: typeof GooglePlayNotifications.processGooglePlayKiloPassNotification;

const GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS = Date.parse('2026-05-15T00:00:00.000Z');

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
    getPosthogTrackingMock().trackKiloPassPurchaseCompleted.mockClear();
    dateNowSpy.mockReturnValue(GOOGLE_PLAY_NOTIFICATION_TEST_NOW_MS);
    mockGetGooglePlaySubscriptionOrder.mockClear();
    mockGetGooglePlaySubscriptionPurchase.mockReset();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiData());
  });

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
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId));

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-canceled',
        messageId: 'cancel-initial',
      }),
    });

    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
      apiDataForUser(obfsAccountId, undefined, {
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

  it('ignores a stale cancellation when Play reports the subscription as active', async () => {
    const { obfsAccountId } = await insertGooglePlayUser();
    mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(apiDataForUser(obfsAccountId));

    await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 4,
        purchaseToken: 'purchase-token-cancel-stale',
        messageId: 'cancel-stale-initial',
      }),
    });

    const result = await processGooglePlayKiloPassNotification({
      pubsubMessage: pubsubMessage({
        notificationType: 3,
        purchaseToken: 'purchase-token-cancel-stale',
        messageId: 'cancel-stale-1',
      }),
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, 'purchase-token-cancel-stale')
      ),
    });
    expect(subscription?.cancel_at_period_end).toBe(false);
    expect(subscription?.status).toBe('active');
  });

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
  it('issues new credits and advances streak for the next paid month', async () => {
    const { user, obfsAccountId } = await insertGooglePlayUser();
    const token = 'parity-review-token';
    for (const [index, now, expiry] of [
      [0, '2026-05-01T09:00:00.000Z', '2026-06-01T09:00:00.000Z'],
      [1, '2026-06-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z'],
    ] as const) {
      dateNowSpy.mockReturnValue(Date.parse(now));
      mockGetGooglePlaySubscriptionPurchase.mockResolvedValue(
        apiDataForUser(obfsAccountId, `parity-order-${index}`, {
          startTime: '2026-05-01T09:00:00.000Z',
          lineItems: [
            {
              productId: 'kilopass_tier19',
              expiryTime: expiry,
              latestSuccessfulOrderId: `parity-order-${index}`,
            },
          ],
        })
      );
      mockGetGooglePlaySubscriptionOrder.mockResolvedValueOnce({
        orderId: `parity-order-${index}`,
        purchaseToken: token,
        state: 'PROCESSED',
        lineItems: [
          {
            productId: 'kilopass_tier19',
            subscriptionDetails: { servicePeriodStartTime: now, servicePeriodEndTime: expiry },
          },
        ],
      });
      await processGooglePlayKiloPassNotification({
        pubsubMessage: pubsubMessage({
          notificationType: index === 0 ? 4 : 2,
          purchaseToken: token,
          messageId: `parity-event-${index}`,
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
      toMicrodollars(38)
    );
  });
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
});
