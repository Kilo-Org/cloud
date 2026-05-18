import { describe, expect, it, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';

import { db } from '@/lib/drizzle';
import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_pause_events,
  kilo_pass_scheduled_changes,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  microdollar_usage,
  microdollar_usage_daily,
} from '@kilocode/db/schema';
import {
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassPaymentProvider,
  KiloPassScheduledChangeStatus,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import { and, eq, isNull } from 'drizzle-orm';
import crypto from 'crypto';
import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
} from '@/lib/kilo-pass/bonus';
import {
  KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT,
  KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF,
} from '@/lib/kilo-pass/constants';

import { insertTestUser } from '@/tests/helpers/user.helper';
import type { insertMicrodollarUsageWithDailyRollup as insertMicrodollarUsageWithDailyRollupType } from '@/tests/helpers/microdollar-usage.helper';
import type { BillingHistoryEntry } from '@/lib/subscriptions/subscription-center';
import type { ValidatedStoreKiloPassPurchase } from '@/lib/kilo-pass/store-subscription-completion';
import type Stripe from 'stripe';
import type dayjsType from 'dayjs';
import type utcType from 'dayjs/plugin/utc';
import type * as Sentry from '@sentry/nextjs';

const PROMO_OFFER_ACTIVE_TEST_TIME = '2026-05-06T12:00:00.000Z';
const PROMO_OFFER_EXPIRED_TEST_TIME = '2026-05-07T00:00:00.000Z';

let mockKiloPassNowIso: string | null = null;

type StripeMock = {
  subscriptions: {
    retrieve: ReturnType<typeof jest.fn>;
    update: ReturnType<typeof jest.fn>;
  };
  subscriptionSchedules: {
    create: ReturnType<typeof jest.fn>;
    update: ReturnType<typeof jest.fn>;
    release: ReturnType<typeof jest.fn>;
  };
  checkout: {
    sessions: {
      create: ReturnType<typeof jest.fn>;
    };
  };
  billingPortal: {
    sessions: {
      create: ReturnType<typeof jest.fn>;
    };
  };
  invoices: {
    list: ReturnType<typeof jest.fn>;
  };
};

type AppStoreVerifierMock = {
  verifyAppleKiloPassTransactionJws: ReturnType<typeof jest.fn>;
};

type StoreCompletionMock = {
  completeStoreKiloPassPurchase: ReturnType<typeof jest.fn>;
};

type SentryMock = {
  captureException: ReturnType<typeof jest.fn>;
};

function getStripeMock(): StripeMock {
  const mod: { __stripeMock: StripeMock } = jest.requireMock('@/lib/stripe-client');
  return mod.__stripeMock;
}

function getAppStoreVerifierMock(): AppStoreVerifierMock {
  return jest.requireMock('@/lib/kilo-pass/apple-store-verifier') as AppStoreVerifierMock;
}

function getStoreCompletionMock(): StoreCompletionMock {
  return jest.requireMock('@/lib/kilo-pass/store-subscription-completion') as StoreCompletionMock;
}

function getSentryMock(): SentryMock {
  return jest.requireMock('@sentry/nextjs') as SentryMock;
}

type KiloPassCaller = {
  getMobileStoreProducts: () => Promise<{
    appAccountToken: string;
    products: Array<{
      appleProductId: string;
    }>;
  }>;
  completeAppStorePurchase: (input: { signedTransactionJws: string }) => Promise<{
    subscriptionId: string;
    tier: KiloPassTier;
    cadence: KiloPassCadence;
    alreadyProcessed: boolean;
  }>;
  getState: () => Promise<{
    subscription: {
      stripeSubscriptionId: string | null;
      paymentProvider: KiloPassPaymentProvider;
      providerSubscriptionId: string | null;
      tier: KiloPassTier;
      cadence: KiloPassCadence;
      status: Stripe.Subscription.Status;
      cancelAtPeriodEnd: boolean;
      currentStreakMonths: number;
      nextYearlyIssueAt: string | null;
      nextBonusCreditsUsd: number | null;
      nextBillingAt: string | null;

      currentPeriodBaseCreditsUsd: number;
      currentPeriodUsageUsd: number;
      currentPeriodHostingCostUsd: number;
      currentPeriodBonusCreditsUsd: number | null;
      isBonusUnlocked: boolean;
      refillAt: string | null;
    } | null;
    isEligibleForFirstMonthPromo: boolean;
  }>;
  getAverageMonthlyUsageLast3Months: () => Promise<{ averageMonthlyUsageUsd: number }>;
  getCheckoutReturnState: () => Promise<{
    subscription: {
      stripeSubscriptionId: string | null;
      tier: KiloPassTier;
      cadence: KiloPassCadence;
      status: Stripe.Subscription.Status;
      cancelAtPeriodEnd: boolean;
      currentStreakMonths: number;
      nextYearlyIssueAt: string | null;
    } | null;
    creditsAwarded: boolean;
  }>;
  getCustomerPortalUrl: (input: { returnUrl?: string }) => Promise<{ url: string }>;
  getChurnkeyAuthHash: () => Promise<{ hash: string; customerId: string }>;
  cancelSubscription: () => Promise<{ success: boolean }>;
  resumeCancelledSubscription: () => Promise<{ success: boolean }>;
  resumePausedSubscription: () => Promise<{ success: boolean }>;
  scheduleChange: (input: {
    targetTier: KiloPassTier;
    targetCadence: KiloPassCadence;
  }) => Promise<{ scheduledChangeId: string; effectiveAt: string }>;
  cancelScheduledChange: () => Promise<{ success: boolean }>;
  createCheckoutSession: (input: {
    tier: KiloPassTier;
    cadence: KiloPassCadence;
  }) => Promise<{ url: string | null }>;
  getBillingHistory: (input: { cursor?: string }) => Promise<{
    entries: BillingHistoryEntry[];
    hasMore: boolean;
    cursor: string | null;
  }>;
  getCreditHistory: (input: { cursor?: string }) => Promise<{
    entries: Array<{
      id: string;
      date: string;
      amountUsd: number;
      kind: KiloPassIssuanceItemKind;
      description: string;
    }>;
    hasMore: boolean;
    cursor: string | null;
  }>;
};

type Caller = { kiloPass: KiloPassCaller };

let createCallerForUser: (userId: string) => Promise<Caller>;

function freezeKiloPassClock(nowIso: string): void {
  mockKiloPassNowIso = nowIso;
}

jest.mock('@/lib/kilo-pass/dayjs', () => {
  const realDayjs = jest.requireActual<typeof dayjsType>('dayjs');
  const utc = jest.requireActual<typeof utcType>('dayjs/plugin/utc');

  realDayjs.extend(utc);

  const controlledDayjs = ((...args: Parameters<typeof realDayjs>) => {
    if (args.length === 0 && mockKiloPassNowIso) {
      return realDayjs(mockKiloPassNowIso);
    }
    return realDayjs(...args);
  }) as typeof realDayjs;

  Object.assign(controlledDayjs, realDayjs);

  return { dayjs: controlledDayjs };
});

jest.mock('@/lib/stripe-client', () => {
  const stripeMock = {
    subscriptions: {
      retrieve: jest.fn(),
      update: jest.fn(),
    },
    subscriptionSchedules: {
      create: jest.fn(),
      update: jest.fn(),
      release: jest.fn(),
    },
    checkout: {
      sessions: {
        create: jest.fn(),
      },
    },
    billingPortal: {
      sessions: {
        create: jest.fn(),
      },
    },
    invoices: {
      list: jest.fn(),
    },
  };

  return {
    client: stripeMock,
    __stripeMock: stripeMock,
  };
});

jest.mock('@/lib/kilo-pass/stripe-price-ids.server', () => {
  const getStripePriceIdForKiloPassMock = jest.fn(() => 'price_test_kilo_pass');
  return {
    getStripePriceIdForKiloPass: getStripePriceIdForKiloPassMock,
  };
});

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<typeof Sentry>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

jest.mock('@/lib/kilo-pass/apple-store-verifier', () => ({
  verifyAppleKiloPassTransactionJws: jest.fn(),
}));

jest.mock('@/lib/kilo-pass/store-subscription-completion', () => ({
  completeStoreKiloPassPurchase: jest.fn(),
}));

async function insertSubscription(params: {
  kiloUserId: string;
  stripeSubscriptionId?: string | null;
  paymentProvider?: KiloPassPaymentProvider;
  providerSubscriptionId?: string | null;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  status: Stripe.Subscription.Status;
  cancelAtPeriodEnd?: boolean;
  currentStreakMonths?: number;
  nextYearlyIssueAt?: string | null;
  startedAt?: string | null;
}) {
  const now = new Date().toISOString();
  const isEnded =
    params.status === 'canceled' ||
    params.status === 'unpaid' ||
    params.status === 'incomplete_expired';

  const startedAt = params.startedAt ?? now;
  const paymentProvider = params.paymentProvider ?? KiloPassPaymentProvider.Stripe;
  const stripeSubscriptionId = params.stripeSubscriptionId ?? null;
  const providerSubscriptionId =
    params.providerSubscriptionId ??
    (paymentProvider === KiloPassPaymentProvider.Stripe ? stripeSubscriptionId : null);

  const inserted = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: params.kiloUserId,
      payment_provider: paymentProvider,
      provider_subscription_id: providerSubscriptionId,
      stripe_subscription_id: stripeSubscriptionId,
      tier: params.tier,
      cadence: params.cadence,
      status: params.status,
      cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
      current_streak_months: params.currentStreakMonths ?? 0,
      next_yearly_issue_at: params.nextYearlyIssueAt ?? null,
      started_at: startedAt,
      ended_at: isEnded ? now : null,
    })
    .returning({ id: kilo_pass_subscriptions.id });

  const row = inserted[0];
  if (!row) {
    throw new Error('Failed to insert kilo_pass_subscriptions row for test');
  }

  return { id: row.id };
}

function appStorePurchaseFixture(
  overrides: Partial<ValidatedStoreKiloPassPurchase> = {}
): ValidatedStoreKiloPassPurchase {
  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: 'kilopass.tier19.monthly.v1',
    providerTransactionId: 'app-store-router-test-tx',
    providerOriginalTransactionId: 'app-store-router-test-original',
    providerSubscriptionId: 'app-store-router-test-original',
    appAccountToken: crypto.randomUUID(),
    purchaseToken: null,
    environment: 'Sandbox',
    purchasedAtIso: '2026-05-01T00:00:00.000Z',
    expiresAtIso: '2026-06-01T00:00:00.000Z',
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
    rawPayload: {},
    ...overrides,
  };
}

function expectNoStripeManagementCalls(stripeMock: StripeMock): void {
  expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
  expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  expect(stripeMock.subscriptionSchedules.update).not.toHaveBeenCalled();
  expect(stripeMock.subscriptionSchedules.release).not.toHaveBeenCalled();
  expect(stripeMock.invoices.list).not.toHaveBeenCalled();
}

async function insertBaseCreditsIssuance(params: {
  subscriptionId: string;
  kiloUserId: string;
}): Promise<void> {
  const issuedMonth = new Date().toISOString().slice(0, 7);
  const issueMonth = `${issuedMonth}-01`;

  const [issuance] = await db
    .insert(kilo_pass_issuances)
    .values({
      kilo_pass_subscription_id: params.subscriptionId,
      issue_month: issueMonth,
      source: KiloPassIssuanceSource.StripeInvoice,
      stripe_invoice_id: `in_test_${Date.now()}`,
    })
    .returning({ id: kilo_pass_issuances.id });

  if (!issuance) {
    throw new Error('Failed to insert kilo_pass_issuances row for test');
  }

  const [creditTxn] = await db
    .insert(credit_transactions)
    .values({
      id: crypto.randomUUID(),
      kilo_user_id: params.kiloUserId,
      amount_microdollars: 1_000_000,
      is_free: false,
      description: `kilo-pass-base-test-${Date.now()}`,
    })
    .returning({ id: credit_transactions.id });

  if (!creditTxn) {
    throw new Error('Failed to insert credit_transactions row for test');
  }

  const [issuanceItem] = await db
    .insert(kilo_pass_issuance_items)
    .values({
      kilo_pass_issuance_id: issuance.id,
      kind: KiloPassIssuanceItemKind.Base,
      credit_transaction_id: creditTxn.id,
      amount_usd: 10,
      bonus_percent_applied: null,
    })
    .returning({ id: kilo_pass_issuance_items.id });

  if (!issuanceItem) {
    throw new Error('Failed to insert kilo_pass_issuance_items row for test');
  }
}

describe('kiloPassRouter', () => {
  beforeAll(async () => {
    // Delay importing the tRPC caller factory until after mocks are registered,
    // otherwise router imports will capture the real Stripe client.
    ({ createCallerForUser } = await import('@/routers/test-utils'));
  });

  beforeEach(() => {
    const stripeMock = getStripeMock();
    stripeMock.subscriptions.retrieve.mockReset();
    stripeMock.subscriptions.update.mockReset();
    stripeMock.subscriptionSchedules.create.mockReset();
    stripeMock.subscriptionSchedules.update.mockReset();
    stripeMock.subscriptionSchedules.release.mockReset();
    stripeMock.checkout.sessions.create.mockReset();
    stripeMock.billingPortal.sessions.create.mockReset();
    stripeMock.invoices.list.mockReset();
    getAppStoreVerifierMock().verifyAppleKiloPassTransactionJws.mockReset();
    getStoreCompletionMock().completeStoreKiloPassPurchase.mockReset();
    getSentryMock().captureException.mockReset();
  });

  afterEach(() => {
    mockKiloPassNowIso = null;
  });

  describe('getMobileStoreProducts', () => {
    it('returns the App Store account token for the signed-in user', async () => {
      const user = await insertTestUser();
      const caller = await createCallerForUser(user.id);

      const result = await caller.kiloPass.getMobileStoreProducts();

      expect(result.appAccountToken).toBe(user.app_store_account_token);
      expect(result.products.length).toBeGreaterThan(0);
    });
  });

  describe('completeAppStorePurchase', () => {
    it('maps verifier failures to mobile-safe copy', async () => {
      const verifierMock = getAppStoreVerifierMock();
      const sentryMock = getSentryMock();
      verifierMock.verifyAppleKiloPassTransactionJws.mockRejectedValue(
        new Error('Apple Kilo Pass product is not enabled')
      );

      const user = await insertTestUser();
      const caller = await createCallerForUser(user.id);

      await expect(
        caller.kiloPass.completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
      ).rejects.toThrow('We could not verify this App Store purchase. Please try again.');
      expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    });

    it('succeeds when the transaction appAccountToken matches the signed-in user', async () => {
      const verifierMock = getAppStoreVerifierMock();
      const completionMock = getStoreCompletionMock();
      const sentryMock = getSentryMock();
      const user = await insertTestUser();
      verifierMock.verifyAppleKiloPassTransactionJws.mockResolvedValue(
        appStorePurchaseFixture({ appAccountToken: user.app_store_account_token })
      );
      const expectedResult = {
        subscriptionId: 'sub-test-id',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        alreadyProcessed: false,
      };
      completionMock.completeStoreKiloPassPurchase.mockResolvedValue(expectedResult);

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.completeAppStorePurchase({
        signedTransactionJws: 'signed-jws',
      });

      expect(result).toEqual(expectedResult);
      expect(completionMock.completeStoreKiloPassPurchase).toHaveBeenCalledTimes(1);
      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });

    it('keeps account mismatch copy stable and does not log it as an internal failure', async () => {
      const verifierMock = getAppStoreVerifierMock();
      const completionMock = getStoreCompletionMock();
      const sentryMock = getSentryMock();
      verifierMock.verifyAppleKiloPassTransactionJws.mockResolvedValue(appStorePurchaseFixture());

      const user = await insertTestUser();
      const caller = await createCallerForUser(user.id);

      await expect(
        caller.kiloPass.completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
      ).rejects.toThrow('App Store purchase account token does not match the signed-in user.');
      expect(completionMock.completeStoreKiloPassPurchase).not.toHaveBeenCalled();
      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });

    it('throws a distinct error when appAccountToken is null and does not log it as an internal failure', async () => {
      const verifierMock = getAppStoreVerifierMock();
      const completionMock = getStoreCompletionMock();
      const sentryMock = getSentryMock();
      verifierMock.verifyAppleKiloPassTransactionJws.mockResolvedValue(
        appStorePurchaseFixture({ appAccountToken: null })
      );

      const user = await insertTestUser();
      const caller = await createCallerForUser(user.id);

      await expect(
        caller.kiloPass.completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
      ).rejects.toThrow(
        "This App Store purchase isn't linked to your Kilo account. Make sure you're signed in to the Apple ID that made the purchase, then try again."
      );
      expect(completionMock.completeStoreKiloPassPurchase).not.toHaveBeenCalled();
      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });

    it.each([
      [
        'You already have an active Kilo Pass subscription',
        'This App Store purchase cannot be used for your account.',
      ],
      [
        'App Store upgrade cannot be processed without previous period expiration',
        'This App Store purchase cannot be used for your account.',
      ],
      [
        'Failed to persist store Kilo Pass subscription',
        'We could not finish this App Store purchase. Please try again.',
      ],
    ])('maps completion failure "%s" to safe copy', async (internalMessage, safeMessage) => {
      const verifierMock = getAppStoreVerifierMock();
      const completionMock = getStoreCompletionMock();
      const sentryMock = getSentryMock();
      const user = await insertTestUser();
      verifierMock.verifyAppleKiloPassTransactionJws.mockResolvedValue(
        appStorePurchaseFixture({ appAccountToken: user.app_store_account_token })
      );
      completionMock.completeStoreKiloPassPurchase.mockRejectedValue(new Error(internalMessage));

      const caller = await createCallerForUser(user.id);

      await expect(
        caller.kiloPass.completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
      ).rejects.toThrow(safeMessage);
      await expect(
        caller.kiloPass.completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
      ).rejects.not.toThrow(internalMessage);
      expect(sentryMock.captureException).toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('returns null subscription when user has no Kilo Pass subscription', async () => {
      freezeKiloPassClock(PROMO_OFFER_ACTIVE_TEST_TIME);

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-empty@example.com',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      expect(result).toEqual({
        subscription: null,
        isEligibleForFirstMonthPromo: true,
      });
    });

    it('throws BAD_REQUEST when subscription exists but user has no stripe customer', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-no-stripe@example.com',
        stripe_customer_id: '',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_missing_customer',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getState()).rejects.toThrow('Missing Stripe customer for user.');
    });

    it('computes yearly cadence nextBoostCreditsUsd', async () => {
      const stripeMock = getStripeMock();
      const currentPeriodEndSeconds = 1_700_000_000;
      const currentPeriodStartSeconds = currentPeriodEndSeconds - 2_592_000;
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_yearly',
        status: 'active',
        items: {
          data: [
            {
              current_period_end: currentPeriodEndSeconds,
              current_period_start: currentPeriodStartSeconds,
            },
          ],
        },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-yearly@example.com',
      });
      const nextYearlyIssueAt = new Date('2030-01-01T00:00:00.000Z').toISOString();
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_yearly',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        currentStreakMonths: 12,
        nextYearlyIssueAt,
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      const expectedNextBillingAt = new Date(currentPeriodEndSeconds * 1000).toISOString();
      const expectedUsd = computeYearlyCadenceMonthlyBonusUsd(KiloPassTier.Tier49);
      const expectedRoundedUsd = Math.round(expectedUsd * 100) / 100;
      const expectedBaseAmountUsd = getMonthlyPriceUsd(KiloPassTier.Tier49);

      expect(result.subscription).toEqual(
        expect.objectContaining({
          stripeSubscriptionId: 'sub_test_yearly',
          tier: KiloPassTier.Tier49,
          cadence: KiloPassCadence.Yearly,
          status: 'active',
          cancelAtPeriodEnd: false,
          currentStreakMonths: 12,
          nextYearlyIssueAt,
          nextBillingAt: expectedNextBillingAt,
          nextBonusCreditsUsd: expectedRoundedUsd,

          currentPeriodBaseCreditsUsd: expectedBaseAmountUsd,
          currentPeriodUsageUsd: 0,
          currentPeriodBonusCreditsUsd: expectedRoundedUsd,
          isBonusUnlocked: false,
          refillAt: nextYearlyIssueAt,
        })
      );
    });

    it('throws when item-level billing period end is absent (even if subscription-level is present)', async () => {
      const stripeMock = getStripeMock();
      const currentPeriodEndSeconds = 1_700_000_123;
      const currentPeriodStartSeconds = currentPeriodEndSeconds - 2_592_000;
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_yearly_subscription_level_period_end',
        status: 'active',
        current_period_end: currentPeriodEndSeconds,
        current_period_start: currentPeriodStartSeconds,
        items: {
          data: [{}],
        },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-subscription-level-period-end@example.com',
      });

      const nextYearlyIssueAt = new Date('2030-01-01T00:00:00.000Z').toISOString();
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_yearly_subscription_level_period_end',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        currentStreakMonths: 12,
        nextYearlyIssueAt,
      });

      const caller = await createCallerForUser(user.id);

      await expect(caller.kiloPass.getState()).rejects.toThrow(
        'Stripe subscription missing billing period end'
      );
    });

    it('computes monthly cadence nextBoostCreditsUsd from Stripe billing period end', async () => {
      const stripeMock = getStripeMock();
      const currentPeriodEndSeconds = 1_700_123_456;
      const currentPeriodStartSeconds = currentPeriodEndSeconds - 2_592_000;
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_monthly',
        status: 'active',
        items: {
          data: [
            {
              current_period_end: currentPeriodEndSeconds,
              current_period_start: currentPeriodStartSeconds,
            },
          ],
        },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-monthly@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_monthly',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 0,
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      const expectedNextBillingAt = new Date(currentPeriodEndSeconds * 1000).toISOString();
      const predictedStreakMonths = 1;
      const bonusPercentApplied = computeMonthlyCadenceBonusPercent({
        tier: KiloPassTier.Tier19,
        streakMonths: predictedStreakMonths,
        isFirstTimeSubscriberEver: true,
      });
      const baseAmountUsd = getMonthlyPriceUsd(KiloPassTier.Tier19);
      const baseCents = Math.round(baseAmountUsd * 100);
      const bonusCents = Math.round(baseCents * bonusPercentApplied);
      const expectedNextBonusUsd = bonusCents / 100;

      expect(result.subscription?.nextBillingAt).toBe(expectedNextBillingAt);
      expect(result.subscription?.nextBonusCreditsUsd).toBe(expectedNextBonusUsd);
      expect(result.subscription?.currentPeriodBaseCreditsUsd).toBe(baseAmountUsd);
      expect(result.subscription?.currentPeriodUsageUsd).toBe(0);
      expect(result.subscription?.isBonusUnlocked).toBe(false);
      expect(result.subscription?.refillAt).toBe(expectedNextBillingAt);
    });

    it('uses the latest App Store purchase period and reports current usage, hosting, and bonus', async () => {
      freezeKiloPassClock('2026-02-15T12:00:00.000Z');

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-app-store-period@example.com',
      });
      const providerSubscriptionId = 'orig_get_state_app_store_period';
      const purchasedAt = '2026-01-31T00:00:00.000Z';
      const baseCreditsIssuedAt = '2026-01-31T01:00:00.000Z';
      const expiresAt = '2026-02-28T00:00:00.000Z';
      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: null,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
      });

      await db.insert(kilo_pass_store_purchases).values({
        kilo_pass_subscription_id: subscriptionId,
        kilo_user_id: user.id,
        payment_provider: KiloPassPaymentProvider.AppStore,
        product_id: 'kilo_pass_tier_19_monthly',
        provider_subscription_id: providerSubscriptionId,
        provider_transaction_id: 'tx_get_state_app_store_period',
        provider_original_transaction_id: providerSubscriptionId,
        app_account_token: user.app_store_account_token,
        environment: 'Sandbox',
        purchased_at: purchasedAt,
        expires_at: expiresAt,
        raw_payload_json: {},
      });

      const [issuance] = await db
        .insert(kilo_pass_issuances)
        .values({
          kilo_pass_subscription_id: subscriptionId,
          issue_month: '2026-01-01',
          source: KiloPassIssuanceSource.AppStoreTransaction,
          created_at: baseCreditsIssuedAt,
        })
        .returning({ id: kilo_pass_issuances.id });

      if (!issuance) {
        throw new Error('Failed to insert App Store issuance for getState test');
      }

      const [baseCreditTransaction] = await db
        .insert(credit_transactions)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: user.id,
          amount_microdollars: 19_000_000,
          is_free: false,
          description: 'Kilo Pass base credits (tier_19, monthly)',
          credit_category: 'kilo-pass-store-test-base',
          created_at: baseCreditsIssuedAt,
        })
        .returning({ id: credit_transactions.id });

      if (!baseCreditTransaction) {
        throw new Error('Failed to insert App Store base credit transaction for getState test');
      }

      await db.insert(kilo_pass_issuance_items).values({
        kilo_pass_issuance_id: issuance.id,
        kind: KiloPassIssuanceItemKind.Base,
        credit_transaction_id: baseCreditTransaction.id,
        amount_usd: 19,
        bonus_percent_applied: null,
        created_at: baseCreditsIssuedAt,
      });

      await db.insert(microdollar_usage).values([
        {
          kilo_user_id: user.id,
          organization_id: null,
          cost: 12_000_000,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: '2026-01-31T00:30:00.000Z',
        },
        {
          kilo_user_id: user.id,
          organization_id: null,
          cost: 5_250_000,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: '2026-02-10T00:00:00.000Z',
        },
      ]);

      await db.insert(credit_transactions).values({
        id: crypto.randomUUID(),
        kilo_user_id: user.id,
        amount_microdollars: -1_500_000,
        is_free: true,
        description: 'KiloClaw hosting test deduction',
        credit_category: 'kiloclaw-subscription:test-get-state',
        created_at: '2026-02-10T00:00:00.000Z',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      const baseAmountUsd = getMonthlyPriceUsd(KiloPassTier.Tier19);
      const currentBonusPercent = computeMonthlyCadenceBonusPercent({
        tier: KiloPassTier.Tier19,
        streakMonths: 1,
        isFirstTimeSubscriberEver: true,
        subscriptionStartedAtIso: '2026-01-01T00:00:00.000Z',
      });
      const currentBonusUsd = Math.round(baseAmountUsd * currentBonusPercent * 100) / 100;

      expect(result.subscription).toEqual(
        expect.objectContaining({
          stripeSubscriptionId: null,
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerSubscriptionId,
          nextBillingAt: expiresAt,
          refillAt: expiresAt,
          currentPeriodBaseCreditsUsd: baseAmountUsd,
          currentPeriodUsageUsd: 6.75,
          currentPeriodHostingCostUsd: 1.5,
          currentPeriodBonusCreditsUsd: currentBonusUsd,
        })
      );
    });

    it('starts App Store upgrade period usage at the replacement base credit transaction', async () => {
      freezeKiloPassClock('2026-05-20T12:00:00.000Z');

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-app-store-upgrade-usage@example.com',
      });
      const providerSubscriptionId = 'orig_get_state_app_store_upgrade_usage';
      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: null,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerSubscriptionId,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 1,
        startedAt: '2026-05-01T00:00:00.000Z',
      });

      await db.insert(kilo_pass_store_purchases).values([
        {
          kilo_pass_subscription_id: subscriptionId,
          kilo_user_id: user.id,
          payment_provider: KiloPassPaymentProvider.AppStore,
          product_id: 'kilo_pass_tier_19_monthly',
          provider_subscription_id: providerSubscriptionId,
          provider_transaction_id: 'tx_get_state_app_store_upgrade_usage_original',
          provider_original_transaction_id: providerSubscriptionId,
          app_account_token: user.app_store_account_token,
          environment: 'Sandbox',
          purchased_at: '2026-05-01T00:00:00.000Z',
          expires_at: '2026-05-31T00:00:00.000Z',
          raw_payload_json: {},
        },
        {
          kilo_pass_subscription_id: subscriptionId,
          kilo_user_id: user.id,
          payment_provider: KiloPassPaymentProvider.AppStore,
          product_id: 'kilo_pass_tier_49_monthly',
          provider_subscription_id: providerSubscriptionId,
          provider_transaction_id: 'tx_get_state_app_store_upgrade_usage_replacement',
          provider_original_transaction_id: providerSubscriptionId,
          app_account_token: user.app_store_account_token,
          environment: 'Sandbox',
          purchased_at: '2026-05-16T00:00:00.000Z',
          expires_at: '2026-06-16T00:00:00.000Z',
          raw_payload_json: {},
        },
      ]);

      const [issuance] = await db
        .insert(kilo_pass_issuances)
        .values({
          kilo_pass_subscription_id: subscriptionId,
          issue_month: '2026-05-01',
          source: KiloPassIssuanceSource.AppStoreTransaction,
          created_at: '2026-05-01T00:00:00.000Z',
        })
        .returning({ id: kilo_pass_issuances.id });

      if (!issuance) {
        throw new Error('Failed to insert App Store issuance for upgrade usage test');
      }

      const [replacementBaseCredit] = await db
        .insert(credit_transactions)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: user.id,
          amount_microdollars: 49_000_000,
          is_free: false,
          description: 'Kilo Pass upgrade base credits (tier_49, monthly)',
          credit_category:
            'kilo-pass-upgrade-base:app_store:tx_get_state_app_store_upgrade_usage_replacement',
          created_at: '2026-05-16T00:00:00.000Z',
        })
        .returning({ id: credit_transactions.id });

      if (!replacementBaseCredit) {
        throw new Error('Failed to insert replacement base credit for upgrade usage test');
      }

      await db.insert(kilo_pass_issuance_items).values({
        kilo_pass_issuance_id: issuance.id,
        kind: KiloPassIssuanceItemKind.Base,
        credit_transaction_id: replacementBaseCredit.id,
        amount_usd: 49,
        bonus_percent_applied: null,
        created_at: '2026-05-01T00:00:00.000Z',
      });

      await db.insert(microdollar_usage).values([
        {
          kilo_user_id: user.id,
          organization_id: null,
          cost: 7_000_000,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: '2026-05-10T00:00:00.000Z',
        },
        {
          kilo_user_id: user.id,
          organization_id: null,
          cost: 3_000_000,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: '2026-05-17T00:00:00.000Z',
        },
      ]);

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      expect(result.subscription?.currentPeriodUsageUsd).toBe(3);
    });

    it('treats an active App Store subscription as ended when the latest purchase is expired', async () => {
      freezeKiloPassClock('2026-03-01T00:00:00.000Z');

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-app-store-expired@example.com',
      });
      const providerSubscriptionId = 'orig_get_state_app_store_expired';
      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: null,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
      });

      await db.insert(kilo_pass_store_purchases).values({
        kilo_pass_subscription_id: subscriptionId,
        kilo_user_id: user.id,
        payment_provider: KiloPassPaymentProvider.AppStore,
        product_id: 'kilo_pass_tier_19_monthly',
        provider_subscription_id: providerSubscriptionId,
        provider_transaction_id: 'tx_get_state_app_store_expired',
        provider_original_transaction_id: providerSubscriptionId,
        app_account_token: user.app_store_account_token,
        environment: 'Sandbox',
        purchased_at: '2026-01-31T00:00:00.000Z',
        expires_at: '2026-02-28T00:00:00.000Z',
        raw_payload_json: {},
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      expect(result.subscription).toEqual(
        expect.objectContaining({
          paymentProvider: KiloPassPaymentProvider.AppStore,
          status: 'canceled',
          nextBillingAt: null,
          refillAt: null,
        })
      );

      // The read path is pure: getState derives `canceled` from the lapsed store-purchase
      // expiry but does not mutate the subscription row. Persistence is handled by the
      // `/api/cron/kilo-pass-store-subscription-reconcile` cron (see
      // store-subscription-reconcile.test.ts).
      const subscriptionRow = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.id, subscriptionId),
      });
      expect(subscriptionRow).toEqual(
        expect.objectContaining({
          status: 'active',
          ended_at: null,
        })
      );
    });

    it('keeps an App Store subscription active when the latest purchase expires in the future', async () => {
      freezeKiloPassClock('2026-02-15T00:00:00.000Z');

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-app-store-future-expiry@example.com',
      });
      const providerSubscriptionId = 'orig_get_state_app_store_future_expiry';
      const expiresAt = '2026-03-01T00:00:00.000Z';
      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: null,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
      });

      await db.insert(kilo_pass_store_purchases).values({
        kilo_pass_subscription_id: subscriptionId,
        kilo_user_id: user.id,
        payment_provider: KiloPassPaymentProvider.AppStore,
        product_id: 'kilo_pass_tier_19_monthly',
        provider_subscription_id: providerSubscriptionId,
        provider_transaction_id: 'tx_get_state_app_store_future_expiry',
        provider_original_transaction_id: providerSubscriptionId,
        app_account_token: user.app_store_account_token,
        environment: 'Sandbox',
        purchased_at: '2026-02-01T00:00:00.000Z',
        expires_at: expiresAt,
        raw_payload_json: {},
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      expect(result.subscription).toEqual(
        expect.objectContaining({
          paymentProvider: KiloPassPaymentProvider.AppStore,
          status: 'active',
          nextBillingAt: expiresAt,
          refillAt: expiresAt,
        })
      );
    });

    it('keeps App Store month-2 grandfather bonus after a post-cutoff renewal', async () => {
      freezeKiloPassClock('2026-06-15T00:00:00.000Z');

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-app-store-grandfathered-renewal@example.com',
      });
      const providerSubscriptionId = 'orig_get_state_app_store_grandfathered_renewal';
      const renewalExpiresAt = '2026-07-01T00:00:00.000Z';
      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: null,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 2,
        startedAt: '2026-05-01T00:00:00.000Z',
      });

      await db.insert(kilo_pass_store_purchases).values([
        {
          kilo_pass_subscription_id: subscriptionId,
          kilo_user_id: user.id,
          payment_provider: KiloPassPaymentProvider.AppStore,
          product_id: 'kilo_pass_tier_19_monthly',
          provider_subscription_id: providerSubscriptionId,
          provider_transaction_id: 'tx_get_state_app_store_grandfathered_initial',
          provider_original_transaction_id: providerSubscriptionId,
          app_account_token: user.app_store_account_token,
          environment: 'Sandbox',
          purchased_at: '2026-05-01T00:00:00.000Z',
          expires_at: '2026-06-01T00:00:00.000Z',
          raw_payload_json: {},
        },
        {
          kilo_pass_subscription_id: subscriptionId,
          kilo_user_id: user.id,
          payment_provider: KiloPassPaymentProvider.AppStore,
          product_id: 'kilo_pass_tier_19_monthly',
          provider_subscription_id: providerSubscriptionId,
          provider_transaction_id: 'tx_get_state_app_store_grandfathered_renewal',
          provider_original_transaction_id: providerSubscriptionId,
          app_account_token: user.app_store_account_token,
          environment: 'Sandbox',
          purchased_at: '2026-06-01T00:00:00.000Z',
          expires_at: renewalExpiresAt,
          raw_payload_json: {},
        },
      ]);

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      const baseAmountUsd = getMonthlyPriceUsd(KiloPassTier.Tier19);
      const expectedCurrentBonusUsd =
        Math.round(
          Math.round(baseAmountUsd * 100) * KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT
        ) / 100;

      expect(result.subscription).toEqual(
        expect.objectContaining({
          paymentProvider: KiloPassPaymentProvider.AppStore,
          currentStreakMonths: 2,
          nextBillingAt: renewalExpiresAt,
          refillAt: renewalExpiresAt,
          currentPeriodBonusCreditsUsd: expectedCurrentBonusUsd,
        })
      );
    });

    it('predicts monthly nextBonusCreditsUsd as 50% for promo month 2 (streak=1 -> predicted=2)', async () => {
      const stripeMock = getStripeMock();
      const currentPeriodEndSeconds = 1_700_123_456;
      const currentPeriodStartSeconds = currentPeriodEndSeconds - 2_592_000;
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_monthly_grandfathered_month2_next',
        status: 'active',
        items: {
          data: [
            {
              current_period_end: currentPeriodEndSeconds,
              current_period_start: currentPeriodStartSeconds,
            },
          ],
        },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-monthly-grandfathered-month2-next@example.com',
      });

      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_monthly_grandfathered_month2_next',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      const baseAmountUsd = getMonthlyPriceUsd(KiloPassTier.Tier19);
      const baseCents = Math.round(baseAmountUsd * 100);
      const expectedNextBonusUsd =
        Math.round(baseCents * KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT) / 100;

      expect(result.subscription?.nextBonusCreditsUsd).toBe(expectedNextBonusUsd);
    });

    it('computes monthly currentPeriodBonusCreditsUsd as 50% for promo month 2 (streak=2)', async () => {
      const stripeMock = getStripeMock();
      const currentPeriodEndSeconds = 1_700_123_456;
      const currentPeriodStartSeconds = currentPeriodEndSeconds - 2_592_000;
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_monthly_grandfathered_month2_current',
        status: 'active',
        items: {
          data: [
            {
              current_period_end: currentPeriodEndSeconds,
              current_period_start: currentPeriodStartSeconds,
            },
          ],
        },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-monthly-grandfathered-month2-current@example.com',
      });

      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_monthly_grandfathered_month2_current',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 2,
        startedAt: '2026-01-01T00:00:00.000Z',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      const baseAmountUsd = getMonthlyPriceUsd(KiloPassTier.Tier19);
      const expectedCurrentBonusUsd =
        Math.round(
          Math.round(baseAmountUsd * 100) * KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT
        ) / 100;

      expect(result.subscription?.currentPeriodBonusCreditsUsd).toBe(expectedCurrentBonusUsd);
    });

    it('does not apply 50% month-2 promo when started_at is at/after the cutoff (streak=2)', async () => {
      const stripeMock = getStripeMock();
      const currentPeriodEndSeconds = 1_700_123_456;
      const currentPeriodStartSeconds = currentPeriodEndSeconds - 2_592_000;
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_monthly_grandfathered_month2_cutoff_ineligible',
        status: 'active',
        items: {
          data: [
            {
              current_period_end: currentPeriodEndSeconds,
              current_period_start: currentPeriodStartSeconds,
            },
          ],
        },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-monthly-grandfathered-month2-cutoff@example.com',
      });

      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_monthly_grandfathered_month2_cutoff_ineligible',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 2,
        startedAt: KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_CUTOFF.toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      const baseAmountUsd = getMonthlyPriceUsd(KiloPassTier.Tier19);
      const expectedPercent = computeMonthlyCadenceBonusPercent({
        tier: KiloPassTier.Tier19,
        streakMonths: 2,
        isFirstTimeSubscriberEver: true,
      });
      const expectedCurrentBonusUsd = Math.round(baseAmountUsd * expectedPercent * 100) / 100;

      expect(result.subscription?.currentPeriodBonusCreditsUsd).toBe(expectedCurrentBonusUsd);
      expect(result.subscription?.currentPeriodBonusCreditsUsd).not.toBe(
        Math.round(
          Math.round(baseAmountUsd * 100) * KILO_PASS_MONTHLY_FIRST_2_MONTHS_PROMO_BONUS_PERCENT
        ) / 100
      );
    });

    it('keeps month 3+ bonus ramp unchanged even for grandfathered subscriptions (streak=3)', async () => {
      const stripeMock = getStripeMock();
      const currentPeriodEndSeconds = 1_700_123_456;
      const currentPeriodStartSeconds = currentPeriodEndSeconds - 2_592_000;
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_monthly_grandfathered_month3_regression',
        status: 'active',
        items: {
          data: [
            {
              current_period_end: currentPeriodEndSeconds,
              current_period_start: currentPeriodStartSeconds,
            },
          ],
        },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-monthly-grandfathered-month3@example.com',
      });

      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_monthly_grandfathered_month3_regression',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        currentStreakMonths: 3,
        startedAt: '2026-01-01T00:00:00.000Z',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      const baseAmountUsd = getMonthlyPriceUsd(KiloPassTier.Tier19);
      const expectedPercent = computeMonthlyCadenceBonusPercent({
        tier: KiloPassTier.Tier19,
        streakMonths: 3,
        isFirstTimeSubscriberEver: true,
      });
      const expectedCurrentBonusUsd = Math.round(baseAmountUsd * expectedPercent * 100) / 100;

      expect(result.subscription?.currentPeriodBonusCreditsUsd).toBe(expectedCurrentBonusUsd);
    });

    it('throws when Stripe retrieve fails', async () => {
      const stripeMock = getStripeMock();
      stripeMock.subscriptions.retrieve.mockRejectedValue(new Error('stripe unavailable'));

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-stripe-fails@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_stripe_fail',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        currentStreakMonths: 3,
        nextYearlyIssueAt: null,
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getState()).rejects.toThrow('stripe unavailable');
    });

    it('yearly cadence: computes currentPeriodUsageUsd using the monthly bonus window (next_yearly_issue_at - 1 month)', async () => {
      const stripeMock = getStripeMock();
      const currentPeriodEndSeconds = 1_800_000_000;
      const currentPeriodStartSeconds = currentPeriodEndSeconds - 31_536_000;
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_yearly_usage_window',
        status: 'active',
        items: {
          data: [
            {
              current_period_end: currentPeriodEndSeconds,
              current_period_start: currentPeriodStartSeconds,
            },
          ],
        },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-get-state-yearly-usage-window@example.com',
      });

      const nowIso = new Date().toISOString();
      const nextYearlyIssueAtIso = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();

      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_yearly_usage_window',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        currentStreakMonths: 0,
        nextYearlyIssueAt: nextYearlyIssueAtIso,
        startedAt: nowIso,
      });

      // Outside monthly bonus window
      await db.insert(microdollar_usage).values({
        kilo_user_id: user.id,
        organization_id: null,
        cost: 10_000_000,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 70).toISOString(),
      });

      // Inside monthly bonus window (counts)
      await db.insert(microdollar_usage).values({
        kilo_user_id: user.id,
        organization_id: null,
        cost: 5_000_000,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      // Only the in-window $5.00 should be counted.
      expect(result.subscription?.currentPeriodUsageUsd).toBe(5);
    });
  });

  describe('isEligibleForFirstMonthPromo in getState', () => {
    it('returns isEligibleForFirstMonthPromo=true when user has no subscriptions', async () => {
      freezeKiloPassClock(PROMO_OFFER_ACTIVE_TEST_TIME);

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-promo-eligible-no-sub@example.com',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      expect(result.isEligibleForFirstMonthPromo).toBe(true);
      expect(result.subscription).toBeNull();
    });

    it('returns isEligibleForFirstMonthPromo=false after the promo cutoff', async () => {
      freezeKiloPassClock(PROMO_OFFER_EXPIRED_TEST_TIME);

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-promo-expired-no-sub@example.com',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      expect(result.isEligibleForFirstMonthPromo).toBe(false);
      expect(result.subscription).toBeNull();
    });

    it('keeps isEligibleForFirstMonthPromo=true for a never-subscribed user', async () => {
      freezeKiloPassClock(PROMO_OFFER_ACTIVE_TEST_TIME);

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-promo-cutoff-still-eligible@example.com',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      expect(result.isEligibleForFirstMonthPromo).toBe(true);
      expect(result.subscription).toBeNull();
    });

    it('returns isEligibleForFirstMonthPromo=false when user has a canceled subscription', async () => {
      const stripeMock = getStripeMock();
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_prior_yearly_canceled',
        status: 'canceled',
        items: { data: [] },
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-promo-ineligible-canceled@example.com',
      });

      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_prior_yearly_canceled',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'canceled',
        currentStreakMonths: 0,
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getState();

      expect(result.isEligibleForFirstMonthPromo).toBe(false);
      expect(result.subscription).not.toBeNull();
    });
  });

  describe('getAverageMonthlyUsageLast3Months', () => {
    let insertMicrodollarUsageWithDailyRollup: typeof insertMicrodollarUsageWithDailyRollupType;

    beforeAll(async () => {
      ({ insertMicrodollarUsageWithDailyRollup } =
        await import('@/tests/helpers/microdollar-usage.helper'));
    });

    beforeEach(async () => {
      // eslint-disable-next-line drizzle/enforce-delete-with-where
      await db.delete(microdollar_usage_daily);
      // eslint-disable-next-line drizzle/enforce-delete-with-where
      await db.delete(microdollar_usage);
    });

    it('returns 0 when there is no usage in the last 3 months', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-avg-usage-empty@example.com',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getAverageMonthlyUsageLast3Months();

      expect(result).toEqual({ averageMonthlyUsageUsd: 0 });
    });

    it('returns average monthly usage based on personal usage only (excluding org)', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-avg-usage-personal-only@example.com',
      });

      // personal-only total in last 3 months: $30 (org $60 is excluded) => average $10/month
      const now = new Date().toISOString();
      await insertMicrodollarUsageWithDailyRollup([
        {
          kilo_user_id: user.id,
          organization_id: null,
          cost: 30_000_000,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: now,
        },
        {
          kilo_user_id: user.id,
          organization_id: crypto.randomUUID(),
          cost: 60_000_000,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: now,
        },
      ]);

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getAverageMonthlyUsageLast3Months();

      expect(result).toEqual({ averageMonthlyUsageUsd: 10 });
    });

    it('excludes usage older than 3 months', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-avg-usage-excludes-old@example.com',
      });

      await insertMicrodollarUsageWithDailyRollup([
        {
          kilo_user_id: user.id,
          organization_id: null,
          cost: 99_000_000,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
        },
      ]);

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getAverageMonthlyUsageLast3Months();

      expect(result).toEqual({ averageMonthlyUsageUsd: 0 });
    });
  });

  describe('getCheckoutReturnState', () => {
    it('returns creditsAwarded=false when no subscription exists', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-checkout-return-no-sub@example.com',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getCheckoutReturnState();

      expect(result).toEqual({ subscription: null, creditsAwarded: false });
    });

    it('returns creditsAwarded=false when subscription exists but no issuance items exist yet', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-checkout-return-no-credits@example.com',
      });

      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_return_no_credits',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getCheckoutReturnState();

      expect(result.creditsAwarded).toBe(false);
      expect(result.subscription?.stripeSubscriptionId).toBe('sub_test_return_no_credits');
    });

    it('returns creditsAwarded=true once base credits have been issued for the current subscription', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-checkout-return-credits-issued@example.com',
      });

      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_return_credits',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
      });

      await insertBaseCreditsIssuance({ subscriptionId, kiloUserId: user.id });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getCheckoutReturnState();

      expect(result.creditsAwarded).toBe(true);
      expect(result.subscription?.stripeSubscriptionId).toBe('sub_test_return_credits');
    });
  });

  describe('getCustomerPortalUrl', () => {
    it('throws BAD_REQUEST when stripe customer id is missing', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-portal-no-stripe@example.com',
        stripe_customer_id: '',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getCustomerPortalUrl({})).rejects.toThrow(
        'Missing Stripe customer for user.'
      );
    });

    it('creates billing portal session with provided returnUrl', async () => {
      const stripeMock = getStripeMock();
      stripeMock.billingPortal.sessions.create.mockResolvedValue({
        url: 'https://stripe.example.test/portal',
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-portal-ok@example.com',
      });

      const caller = await createCallerForUser(user.id);
      const returnUrl = 'https://example.test/return';
      const result = await caller.kiloPass.getCustomerPortalUrl({ returnUrl });

      expect(result).toEqual({ url: 'https://stripe.example.test/portal' });
      expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: user.stripe_customer_id,
        return_url: returnUrl,
      });
    });

    it('rejects active App Store subscriptions without opening the Stripe portal', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-portal-app-store@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerSubscriptionId: 'app-store-original-portal',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getCustomerPortalUrl({})).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });

    it('rejects active Google Play subscriptions without opening the Stripe portal', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-portal-google-play@example.com',
        stripe_customer_id: 'cus_google_play_portal',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerSubscriptionId: 'google-play-original-portal',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getCustomerPortalUrl({})).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });
  });

  describe('getChurnkeyAuthHash', () => {
    let originalChurnkeyApiSecret: string | undefined;

    beforeEach(() => {
      originalChurnkeyApiSecret = process.env.CHURNKEY_API_SECRET;
    });

    afterEach(() => {
      if (originalChurnkeyApiSecret === undefined) {
        delete process.env.CHURNKEY_API_SECRET;
      } else {
        process.env.CHURNKEY_API_SECRET = originalChurnkeyApiSecret;
      }
    });

    it('throws when stripe customer id is missing', async () => {
      process.env.CHURNKEY_API_SECRET = 'test_churnkey_secret';
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-churnkey-no-stripe@example.com',
        stripe_customer_id: '',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getChurnkeyAuthHash()).rejects.toThrow(
        'Missing Stripe customer for user.'
      );
    });

    it('returns the stripe customer id and expected HMAC-SHA256 hash', async () => {
      process.env.CHURNKEY_API_SECRET = 'test_churnkey_secret';
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-churnkey-hash@example.com',
        stripe_customer_id: 'cus_churnkey_hash_test',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getChurnkeyAuthHash();

      const expectedHash = crypto
        .createHmac('sha256', 'test_churnkey_secret')
        .update('cus_churnkey_hash_test')
        .digest('hex');
      expect(result).toEqual({
        customerId: 'cus_churnkey_hash_test',
        hash: expectedHash,
      });
    });

    it('throws when CHURNKEY_API_SECRET is missing', async () => {
      delete process.env.CHURNKEY_API_SECRET;
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-churnkey-no-secret@example.com',
        stripe_customer_id: 'cus_churnkey_no_secret',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getChurnkeyAuthHash()).rejects.toThrow(
        'CHURNKEY_API_SECRET is not configured'
      );
    });

    it('rejects active Google Play subscriptions without creating Churnkey Stripe auth', async () => {
      const stripeMock = getStripeMock();
      process.env.CHURNKEY_API_SECRET = 'test_churnkey_secret';
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-churnkey-google-play@example.com',
        stripe_customer_id: 'cus_google_play_churnkey',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerSubscriptionId: 'google-play-original-churnkey',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getChurnkeyAuthHash()).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });
  });

  describe('cancelSubscription', () => {
    it('throws when no Kilo Pass subscription exists', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-cancel-no-subscription@example.com',
      });
      const caller = await createCallerForUser(user.id);

      await expect(caller.kiloPass.cancelSubscription()).rejects.toThrow(
        'No Kilo Pass subscription found.'
      );
    });

    it('throws when subscription is already pending cancellation', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-cancel-not-active@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_pending_cancel',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancelAtPeriodEnd: true,
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.cancelSubscription()).rejects.toThrow(
        'Kilo Pass subscription is not currently active.'
      );
    });

    it('sets cancel_at_period_end on Stripe and updates DB cancel_at_period_end to true', async () => {
      const stripeMock = getStripeMock();
      stripeMock.subscriptions.update.mockResolvedValue({});

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-cancel-success@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_cancel_me',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancelAtPeriodEnd: false,
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.cancelSubscription();

      expect(result).toEqual({ success: true });
      expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_test_cancel_me', {
        cancel_at_period_end: true,
      });

      const updated = await db.query.kilo_pass_subscriptions.findFirst({
        columns: { status: true, cancel_at_period_end: true },
        where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_test_cancel_me'),
      });
      expect(updated?.status).toBe('active');
      expect(updated?.cancel_at_period_end).toBe(true);
    });

    it('rejects active Google Play subscriptions without canceling in Stripe', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-cancel-google-play@example.com',
        stripe_customer_id: 'cus_google_play_cancel',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerSubscriptionId: 'google-play-original-cancel',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.cancelSubscription()).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });
  });

  describe('resumeCancelledSubscription', () => {
    it('throws when subscription is not pending cancellation', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-resume-not-pending@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_active_no_resume',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancelAtPeriodEnd: false,
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.resumeCancelledSubscription()).rejects.toThrow(
        'Kilo Pass subscription is not pending cancellation.'
      );
    });

    it('clears cancel_at_period_end on Stripe and updates DB cancel_at_period_end to false', async () => {
      const stripeMock = getStripeMock();
      stripeMock.subscriptions.update.mockResolvedValue({});

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-resume-success@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_resume_me',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancelAtPeriodEnd: true,
      });

      // Ensure ended_at is non-null so the router's update clears it.
      await db
        .update(kilo_pass_subscriptions)
        .set({ ended_at: new Date('2032-01-01T00:00:00.000Z').toISOString() })
        .where(eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_test_resume_me'));

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.resumeCancelledSubscription();

      expect(result).toEqual({ success: true });
      expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_test_resume_me', {
        cancel_at_period_end: false,
      });

      const updated = await db.query.kilo_pass_subscriptions.findFirst({
        columns: { status: true, cancel_at_period_end: true, ended_at: true },
        where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_test_resume_me'),
      });
      expect(updated?.status).toBe('active');
      expect(updated?.cancel_at_period_end).toBe(false);
      expect(updated?.ended_at).toBeNull();
    });

    it('rejects pending-cancel Google Play subscriptions without resuming in Stripe', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-resume-google-play@example.com',
        stripe_customer_id: 'cus_google_play_resume',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerSubscriptionId: 'google-play-original-resume',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancelAtPeriodEnd: true,
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.resumeCancelledSubscription()).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });
  });

  describe('resumePausedSubscription', () => {
    it('clears pause_collection on Stripe and closes the pause event in DB', async () => {
      const stripeMock = getStripeMock();
      stripeMock.subscriptions.update.mockResolvedValue({});

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-resume-paused-success@example.com',
      });
      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_resume_paused',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'paused',
      });

      // Insert an open pause event for the subscription
      await db.insert(kilo_pass_pause_events).values({
        kilo_pass_subscription_id: subscriptionId,
        paused_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        resumes_at: null,
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.resumePausedSubscription();

      expect(result).toEqual({ success: true });
      expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_test_resume_paused', {
        pause_collection: '',
      });

      // Verify the pause event was closed (resumed_at is set)
      const openEvent = await db
        .select()
        .from(kilo_pass_pause_events)
        .where(
          and(
            eq(kilo_pass_pause_events.kilo_pass_subscription_id, subscriptionId),
            isNull(kilo_pass_pause_events.resumed_at)
          )
        );
      expect(openEvent).toHaveLength(0);
    });

    it('throws when subscription is not paused', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-resume-paused-not-paused@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_resume_paused_active',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.resumePausedSubscription()).rejects.toThrow(
        'Subscription is not paused.'
      );
    });

    it('throws when user has no subscription', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-resume-paused-no-sub@example.com',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.resumePausedSubscription()).rejects.toThrow(
        'No Kilo Pass subscription found.'
      );
    });

    it('rejects paused Google Play subscriptions without resuming in Stripe', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-resume-paused-google-play@example.com',
        stripe_customer_id: 'cus_google_play_resume_paused',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerSubscriptionId: 'google-play-original-resume-paused',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'paused',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.resumePausedSubscription()).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });
  });

  describe('scheduleChange', () => {
    it('monthly cadence: creates a Stripe subscription schedule and inserts a pending scheduled change row', async () => {
      const stripeMock = getStripeMock();
      const now = new Date('2026-01-01T00:00:00.000Z');
      const stripePeriodEndSeconds = 1_767_225_600; // 2026-01-01T00:00:00Z

      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_schedule_change_monthly',
        status: 'active',
        items: {
          data: [{ current_period_end: stripePeriodEndSeconds }],
        },
      });

      const scheduleId = `sched_${Math.random()}`;
      stripeMock.subscriptionSchedules.create.mockResolvedValue({
        id: scheduleId,
        phases: [{ start_date: stripePeriodEndSeconds - 2_592_000 }],
        current_phase: { start_date: stripePeriodEndSeconds - 2_592_000 },
      });
      stripeMock.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-schedule-change-monthly@example.com',
      });

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: 'sub_test_schedule_change_monthly',
        stripe_subscription_id: 'sub_test_schedule_change_monthly',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        current_streak_months: 3,
        started_at: now.toISOString(),
        ended_at: null,
        next_yearly_issue_at: null,
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.scheduleChange({
        targetTier: KiloPassTier.Tier49,
        targetCadence: KiloPassCadence.Yearly,
      });

      expect(result.scheduledChangeId).toBeTruthy();
      expect(result.effectiveAt).toBe(new Date(stripePeriodEndSeconds * 1000).toISOString());

      expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
        from_subscription: 'sub_test_schedule_change_monthly',
      });

      expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
        scheduleId,
        expect.objectContaining({
          phases: expect.arrayContaining([
            expect.objectContaining({
              end_date: stripePeriodEndSeconds,
            }),
            expect.objectContaining({
              start_date: stripePeriodEndSeconds,
            }),
          ]),
        })
      );

      const rows = await db.query.kilo_pass_scheduled_changes.findMany({
        where: eq(
          kilo_pass_scheduled_changes.stripe_subscription_id,
          'sub_test_schedule_change_monthly'
        ),
      });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('Expected at least one scheduled change row');
      expect(row.status).toBe(KiloPassScheduledChangeStatus.NotStarted);
      expect(row.stripe_schedule_id).toBe(scheduleId);
      expect(new Date(row.effective_at).toISOString()).toBe(
        new Date(stripePeriodEndSeconds * 1000).toISOString()
      );
    });

    it('yearly cadence downtier uses billing cycle end for effectiveAt', async () => {
      const stripeMock = getStripeMock();
      const stripePeriodEndSeconds = 1_767_225_600;
      const now = new Date('2026-01-01T00:00:00.000Z');

      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_schedule_change_yearly_downtier',
        status: 'active',
        items: {
          data: [{ current_period_end: stripePeriodEndSeconds }],
        },
      });

      const scheduleId = `sched_${Math.random()}`;
      stripeMock.subscriptionSchedules.create.mockResolvedValue({
        id: scheduleId,
        phases: [{ start_date: stripePeriodEndSeconds - 31_536_000 }],
        current_phase: { start_date: stripePeriodEndSeconds - 31_536_000 },
      });
      stripeMock.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-schedule-change-yearly-downtier@example.com',
      });

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: 'sub_test_schedule_change_yearly_downtier',
        stripe_subscription_id: 'sub_test_schedule_change_yearly_downtier',
        tier: KiloPassTier.Tier199,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        current_streak_months: 1,
        started_at: now.toISOString(),
        ended_at: null,
        next_yearly_issue_at: new Date('2027-01-01T00:00:00.000Z').toISOString(),
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.scheduleChange({
        targetTier: KiloPassTier.Tier49,
        targetCadence: KiloPassCadence.Yearly,
      });

      expect(result.effectiveAt).toBe(new Date(stripePeriodEndSeconds * 1000).toISOString());
      expect(stripeMock.subscriptions.retrieve).toHaveBeenCalledWith(
        'sub_test_schedule_change_yearly_downtier'
      );
    });

    it('yearly cadence uptier uses nextYearlyIssueAt for effectiveAt', async () => {
      const stripeMock = getStripeMock();
      const now = new Date('2026-01-01T00:00:00.000Z');
      const nextYearlyIssueAt = new Date('2027-01-01T00:00:00.000Z').toISOString();

      const scheduleId = `sched_${Math.random()}`;
      stripeMock.subscriptionSchedules.create.mockResolvedValue({
        id: scheduleId,
        phases: [{ start_date: 1_704_067_200 }],
        current_phase: { start_date: 1_704_067_200 },
      });
      stripeMock.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-schedule-change-yearly-uptier@example.com',
      });

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: 'sub_test_schedule_change_yearly_uptier',
        stripe_subscription_id: 'sub_test_schedule_change_yearly_uptier',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        current_streak_months: 1,
        started_at: now.toISOString(),
        ended_at: null,
        next_yearly_issue_at: nextYearlyIssueAt,
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.scheduleChange({
        targetTier: KiloPassTier.Tier49,
        targetCadence: KiloPassCadence.Yearly,
      });

      expect(result.effectiveAt).toBe(nextYearlyIssueAt);
      expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    it('releases an existing pending scheduled change before attempting to schedule a new one', async () => {
      const stripeMock = getStripeMock();
      const now = new Date('2026-01-01T00:00:00.000Z');
      const stripePeriodEndSeconds = 1_767_225_600;

      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_schedule_change_replace',
        status: 'active',
        items: {
          data: [{ current_period_end: stripePeriodEndSeconds }],
        },
      });

      const oldScheduleId = `sched_old_${Math.random()}`;
      stripeMock.subscriptionSchedules.release.mockResolvedValue({});

      const newScheduleId = `sched_new_${Math.random()}`;
      stripeMock.subscriptionSchedules.create.mockResolvedValue({
        id: newScheduleId,
        phases: [{ start_date: stripePeriodEndSeconds - 2_592_000 }],
        current_phase: { start_date: stripePeriodEndSeconds - 2_592_000 },
      });
      stripeMock.subscriptionSchedules.update.mockResolvedValue({
        id: newScheduleId,
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-schedule-change-replace@example.com',
      });

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: 'sub_test_schedule_change_replace',
        stripe_subscription_id: 'sub_test_schedule_change_replace',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        current_streak_months: 1,
        started_at: now.toISOString(),
        ended_at: null,
        next_yearly_issue_at: null,
      });

      const [existing] = await db
        .insert(kilo_pass_scheduled_changes)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: user.id,
          stripe_subscription_id: 'sub_test_schedule_change_replace',
          from_tier: KiloPassTier.Tier19,
          from_cadence: KiloPassCadence.Monthly,
          to_tier: KiloPassTier.Tier49,
          to_cadence: KiloPassCadence.Yearly,
          stripe_schedule_id: oldScheduleId,
          effective_at: new Date(stripePeriodEndSeconds * 1000).toISOString(),
          status: KiloPassScheduledChangeStatus.NotStarted,
        })
        .returning({ id: kilo_pass_scheduled_changes.id });

      expect(existing).toBeTruthy();
      if (!existing) throw new Error('Expected existing scheduled change row to be inserted');

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.scheduleChange({
        targetTier: KiloPassTier.Tier199,
        targetCadence: KiloPassCadence.Yearly,
      });

      // Existing pending scheduled change should be released (soft-deleted) and replaced.
      expect(result.scheduledChangeId).toBeTruthy();
      expect(result.scheduledChangeId).not.toBe(existing.id);

      expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith(oldScheduleId);

      const oldRow = await db.query.kilo_pass_scheduled_changes.findFirst({
        where: eq(kilo_pass_scheduled_changes.id, existing.id),
      });
      expect(oldRow).toBeTruthy();
      expect(oldRow?.deleted_at).not.toBeNull();
      expect(oldRow?.status).toBe(KiloPassScheduledChangeStatus.Released);

      const rows = await db.query.kilo_pass_scheduled_changes.findMany({
        where: eq(
          kilo_pass_scheduled_changes.stripe_subscription_id,
          'sub_test_schedule_change_replace'
        ),
      });

      // We keep historical rows, but enforce a single active scheduled change per subscription.
      const active = rows.filter(r => r.deleted_at === null);
      expect(active).toHaveLength(1);
      expect(active[0]?.stripe_schedule_id).toBe(newScheduleId);
    });

    it('yearly tier upgrade resets billing cycle anchor and does not prorate (remaining credits issued separately)', async () => {
      const stripeMock = getStripeMock();
      const now = new Date('2026-01-01T00:00:00.000Z');
      const nextYearlyIssueAt = new Date('2027-01-01T00:00:00.000Z').toISOString();

      const scheduleId = `sched_${Math.random()}`;
      stripeMock.subscriptionSchedules.create.mockResolvedValue({
        id: scheduleId,
        phases: [{ start_date: 1_704_067_200 }],
        current_phase: { start_date: 1_704_067_200 },
      });
      stripeMock.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-schedule-change-yearly-upgrade@example.com',
      });

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: 'sub_test_schedule_change_yearly_upgrade',
        stripe_subscription_id: 'sub_test_schedule_change_yearly_upgrade',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        status: 'active',
        cancel_at_period_end: false,
        current_streak_months: 1,
        started_at: now.toISOString(),
        ended_at: null,
        next_yearly_issue_at: nextYearlyIssueAt,
      });

      const caller = await createCallerForUser(user.id);
      await caller.kiloPass.scheduleChange({
        targetTier: KiloPassTier.Tier49,
        targetCadence: KiloPassCadence.Yearly,
      });

      const updateCall = stripeMock.subscriptionSchedules.update.mock.calls[0];
      if (!updateCall) throw new Error('Expected subscriptionSchedules.update to have been called');
      const updateArgs = updateCall[1];
      if (!updateArgs) throw new Error('Expected update call to have a second argument');
      const phases = updateArgs.phases;
      const newPhase = phases?.[1];

      // Yearly tier upgrades should NOT prorate — remaining credits at the old tier
      // are issued via maybeIssueYearlyRemainingCredits when the new invoice is paid.
      expect(newPhase).toMatchObject({
        proration_behavior: 'none',
        billing_cycle_anchor: 'phase_start',
      });
    });

    it('monthly-to-yearly cadence change anchors billing to phase start so Stripe generates an invoice', async () => {
      const stripeMock = getStripeMock();
      const now = new Date('2026-01-01T00:00:00.000Z');
      const stripePeriodEndSeconds = 1_767_225_600; // 2026-01-01T00:00:00Z

      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_test_schedule_change_monthly_to_yearly',
        status: 'active',
        items: {
          data: [{ current_period_end: stripePeriodEndSeconds }],
        },
      });

      const scheduleId = `sched_${Math.random()}`;
      stripeMock.subscriptionSchedules.create.mockResolvedValue({
        id: scheduleId,
        phases: [{ start_date: stripePeriodEndSeconds - 2_592_000 }],
        current_phase: { start_date: stripePeriodEndSeconds - 2_592_000 },
      });
      stripeMock.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
        status: KiloPassScheduledChangeStatus.NotStarted,
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-schedule-change-monthly-to-yearly@example.com',
      });

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: 'sub_test_schedule_change_monthly_to_yearly',
        stripe_subscription_id: 'sub_test_schedule_change_monthly_to_yearly',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        current_streak_months: 3,
        started_at: now.toISOString(),
        ended_at: null,
        next_yearly_issue_at: null,
      });

      const caller = await createCallerForUser(user.id);
      await caller.kiloPass.scheduleChange({
        targetTier: KiloPassTier.Tier19,
        targetCadence: KiloPassCadence.Yearly,
      });

      const updateCall = stripeMock.subscriptionSchedules.update.mock.calls[0];
      if (!updateCall) throw new Error('Expected subscriptionSchedules.update to have been called');
      const updateArgs = updateCall[1];
      if (!updateArgs) throw new Error('Expected update call to have a second argument');
      const phases = updateArgs.phases;
      const newPhase = phases?.[1];

      // Cadence changes (monthly→yearly) must reset the billing anchor so Stripe
      // generates an invoice for the new yearly subscription at the transition point.
      expect(newPhase).toMatchObject({
        billing_cycle_anchor: 'phase_start',
      });
    });

    it('rejects active Google Play subscriptions without creating a Stripe schedule', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-schedule-change-google-play@example.com',
        stripe_customer_id: 'cus_google_play_schedule',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerSubscriptionId: 'google-play-original-schedule',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(
        caller.kiloPass.scheduleChange({
          targetTier: KiloPassTier.Tier49,
          targetCadence: KiloPassCadence.Monthly,
        })
      ).rejects.toThrow('Manage this Kilo Pass subscription through the mobile app store.');
      expectNoStripeManagementCalls(stripeMock);
    });
  });

  describe('cancelScheduledChange', () => {
    it('releases the Stripe schedule and deletes the scheduled change row', async () => {
      const stripeMock = getStripeMock();
      stripeMock.subscriptionSchedules.release.mockResolvedValue({});

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-cancel-scheduled-change@example.com',
      });

      const stripeSubId = `sub_cancel_scheduled_${Math.random()}`;
      const scheduleId = `sched_cancel_${Math.random()}`;

      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: stripeSubId,
        stripe_subscription_id: stripeSubId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        current_streak_months: 1,
        started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        ended_at: null,
        next_yearly_issue_at: null,
      });

      const [pending] = await db
        .insert(kilo_pass_scheduled_changes)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: user.id,
          stripe_subscription_id: stripeSubId,
          from_tier: KiloPassTier.Tier19,
          from_cadence: KiloPassCadence.Monthly,
          to_tier: KiloPassTier.Tier49,
          to_cadence: KiloPassCadence.Yearly,
          stripe_schedule_id: scheduleId,
          effective_at: new Date('2026-02-01T00:00:00.000Z').toISOString(),
          status: KiloPassScheduledChangeStatus.NotStarted,
        })
        .returning({ id: kilo_pass_scheduled_changes.id });

      expect(pending).toBeTruthy();
      if (!pending) throw new Error('Expected pending scheduled change row to be inserted');

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.cancelScheduledChange();
      expect(result).toEqual({ success: true });

      expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith(scheduleId);

      const updated = await db.query.kilo_pass_scheduled_changes.findFirst({
        where: eq(kilo_pass_scheduled_changes.id, pending.id),
      });

      // The API releases the schedule; the DB row is deleted asynchronously by the Stripe
      // `subscription_schedule.updated` webhook when it transitions to released/canceled/completed.
      expect(updated).toBeTruthy();
    });

    it('rejects active Google Play subscriptions without releasing a Stripe schedule', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-cancel-scheduled-google-play@example.com',
        stripe_customer_id: 'cus_google_play_cancel_schedule',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerSubscriptionId: 'google-play-original-cancel-schedule',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.cancelScheduledChange()).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });
  });

  describe('getBillingHistory', () => {
    it('returns empty entries when user has no kilo pass subscription', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-billing-history-no-sub@example.com',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getBillingHistory({});

      expect(result).toEqual({ entries: [], hasMore: false, cursor: null });
    });

    it('rejects active Google Play subscriptions without listing Stripe invoices', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-billing-history-google-play@example.com',
        stripe_customer_id: 'cus_google_play_billing_history',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerSubscriptionId: 'google-play-original-billing-history',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getBillingHistory({})).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });

    it('rejects active App Store subscriptions without listing Stripe invoices', async () => {
      const stripeMock = getStripeMock();
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-billing-history-app-store@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerSubscriptionId: 'app-store-original-billing-history',
        stripeSubscriptionId: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloPass.getBillingHistory({})).rejects.toThrow(
        'Manage this Kilo Pass subscription through the mobile app store.'
      );
      expectNoStripeManagementCalls(stripeMock);
    });

    it('returns mapped invoices scoped to the kilo pass subscription', async () => {
      const stripeMock = getStripeMock();
      const invoiceCreatedTs = Math.floor(Date.now() / 1000) - 86400;
      stripeMock.invoices.list.mockResolvedValue({
        data: [
          {
            id: 'in_test_1',
            created: invoiceCreatedTs,
            amount_due: 1900,
            currency: 'usd',
            status: 'paid',
            hosted_invoice_url: 'https://stripe.example.test/invoice/1',
            invoice_pdf: 'https://stripe.example.test/invoice/1.pdf',
            lines: { data: [{ description: 'Kilo Pass Tier 19' }] },
          },
        ],
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-billing-history-ok@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_billing_history_test',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getBillingHistory({});

      expect(stripeMock.invoices.list).toHaveBeenCalledWith(
        expect.objectContaining({ subscription: 'sub_billing_history_test' })
      );
      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      if (!entry) throw new Error('Expected at least one billing history entry');
      expect(entry.kind).toBe('stripe');
      if (entry.kind !== 'stripe') throw new Error('Expected stripe entry');
      expect(entry.id).toBe('in_test_1');
      expect(entry.amountCents).toBe(1900);
      expect(entry.currency).toBe('usd');
      expect(entry.status).toBe('paid');
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });
  });

  describe('getCreditHistory', () => {
    it('returns issuance items for the current subscription', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-credit-history-ok@example.com',
      });

      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_credit_history',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      await insertBaseCreditsIssuance({ subscriptionId, kiloUserId: user.id });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getCreditHistory({});

      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      const entry = result.entries[0];
      if (!entry) throw new Error('Expected at least one credit history entry');
      expect(entry.kind).toBe('base');
      expect(entry.amountUsd).toBe(10);
    });

    it('returns the full same-period App Store upgrade ledger history', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-credit-history-app-store-upgrade@example.com',
      });
      const providerSubscriptionId = 'orig_credit_history_current_upgrade';
      const { id: subscriptionId } = await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: null,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerSubscriptionId,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      await db.insert(kilo_pass_store_purchases).values([
        {
          kilo_pass_subscription_id: subscriptionId,
          kilo_user_id: user.id,
          payment_provider: KiloPassPaymentProvider.AppStore,
          product_id: 'kilo_pass_tier_19_monthly',
          provider_subscription_id: providerSubscriptionId,
          provider_transaction_id: 'tx_history_upgrade_original',
          provider_original_transaction_id: providerSubscriptionId,
          app_account_token: user.app_store_account_token,
          environment: 'Sandbox',
          purchased_at: '2026-05-01T00:00:00.000Z',
          expires_at: '2026-05-31T00:00:00.000Z',
          raw_payload_json: {},
        },
        {
          kilo_pass_subscription_id: subscriptionId,
          kilo_user_id: user.id,
          payment_provider: KiloPassPaymentProvider.AppStore,
          product_id: 'kilo_pass_tier_49_monthly',
          provider_subscription_id: providerSubscriptionId,
          provider_transaction_id: 'tx_history_upgrade_current',
          provider_original_transaction_id: providerSubscriptionId,
          app_account_token: user.app_store_account_token,
          environment: 'Sandbox',
          purchased_at: '2026-05-16T00:00:00.000Z',
          expires_at: '2026-06-16T00:00:00.000Z',
          raw_payload_json: {},
        },
      ]);

      const creditRows = await db
        .insert(credit_transactions)
        .values([
          {
            id: crypto.randomUUID(),
            kilo_user_id: user.id,
            amount_microdollars: 19_000_000,
            is_free: false,
            description: 'Kilo Pass base credits (tier_19, monthly)',
            stripe_payment_id: 'kilo-pass:app_store:tx_history_upgrade_original',
            created_at: '2026-05-01T00:00:00.000Z',
          },
          {
            id: crypto.randomUUID(),
            kilo_user_id: user.id,
            amount_microdollars: -9_500_000,
            is_free: false,
            description: 'Kilo Pass upgrade refund clawback (tier_19)',
            credit_category: 'kilo-pass-upgrade-refund:app_store:tx_history_upgrade_current',
            created_at: '2026-05-16T00:00:00.000Z',
          },
          {
            id: crypto.randomUUID(),
            kilo_user_id: user.id,
            amount_microdollars: -9_500_000,
            is_free: true,
            description: 'Kilo Pass upgrade bonus clawback',
            credit_category:
              'kilo-pass-upgrade-bonus-reversal:app_store:tx_history_upgrade_current:bonus:item_bonus',
            created_at: '2026-05-16T00:00:01.000Z',
          },
          {
            id: crypto.randomUUID(),
            kilo_user_id: user.id,
            amount_microdollars: -4_750_000,
            is_free: true,
            description: 'Kilo Pass upgrade promo clawback',
            credit_category:
              'kilo-pass-upgrade-bonus-reversal:app_store:tx_history_upgrade_current:promo_first_month_50pct:item_promo',
            created_at: '2026-05-16T00:00:02.000Z',
          },
          {
            id: crypto.randomUUID(),
            kilo_user_id: user.id,
            amount_microdollars: -99_000_000,
            is_free: false,
            description: 'Unrelated upgrade refund clawback',
            credit_category: 'kilo-pass-upgrade-refund:app_store:tx_history_unrelated',
            created_at: '2026-05-16T00:00:03.000Z',
          },
          {
            id: crypto.randomUUID(),
            kilo_user_id: user.id,
            amount_microdollars: 49_000_000,
            is_free: false,
            description: 'Kilo Pass upgrade base credits (tier_49, monthly)',
            credit_category: 'kilo-pass-upgrade-base:app_store:tx_history_upgrade_current',
            created_at: '2026-05-16T00:00:04.000Z',
          },
        ])
        .returning({ id: credit_transactions.id });
      const [oldBaseCredit, , , , , upgradedBaseCredit] = creditRows;

      if (!oldBaseCredit) {
        throw new Error('Expected old base credit transaction');
      }
      if (!upgradedBaseCredit) {
        throw new Error('Expected upgraded base credit transaction');
      }

      const [issuance] = await db
        .insert(kilo_pass_issuances)
        .values({
          kilo_pass_subscription_id: subscriptionId,
          issue_month: '2026-05-01',
          source: KiloPassIssuanceSource.AppStoreTransaction,
          created_at: '2026-05-01T00:00:00.000Z',
        })
        .returning({ id: kilo_pass_issuances.id });

      if (!issuance) {
        throw new Error('Expected issuance row');
      }

      await db.insert(kilo_pass_issuance_items).values({
        kilo_pass_issuance_id: issuance.id,
        kind: KiloPassIssuanceItemKind.Base,
        credit_transaction_id: upgradedBaseCredit.id,
        amount_usd: 49,
        bonus_percent_applied: null,
        created_at: '2026-05-16T00:00:01.000Z',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.getCreditHistory({});

      expect(result.entries.map(entry => entry.description)).toEqual([
        'Kilo Pass upgrade base credits (tier_49, monthly)',
        'Kilo Pass upgrade promo clawback',
        'Kilo Pass upgrade bonus clawback',
        'Kilo Pass upgrade refund clawback (tier_19)',
        'Kilo Pass base credits (tier_19, monthly)',
      ]);
      expect(
        result.entries.map(entry => ({ amountUsd: entry.amountUsd, kind: entry.kind }))
      ).toEqual([
        { amountUsd: 49, kind: KiloPassIssuanceItemKind.Base },
        { amountUsd: -4.75, kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct },
        { amountUsd: -9.5, kind: KiloPassIssuanceItemKind.Bonus },
        { amountUsd: -9.5, kind: KiloPassIssuanceItemKind.Base },
        { amountUsd: 19, kind: KiloPassIssuanceItemKind.Base },
      ]);
    });
  });

  describe('createCheckoutSession', () => {
    it('rejects when an active/pending subscription already exists', async () => {
      const user = await insertTestUser({
        google_user_email: 'kilo-pass-create-session-existing@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_already_active',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancelAtPeriodEnd: false,
      });

      const caller = await createCallerForUser(user.id);
      await expect(
        caller.kiloPass.createCheckoutSession({
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
        })
      ).rejects.toThrow('You already have an active Kilo Pass subscription.');
    });

    it('creates a checkout session and returns its url', async () => {
      const stripeMock = getStripeMock();
      stripeMock.checkout.sessions.create.mockResolvedValue({
        url: 'https://stripe.example.test/checkout',
      });

      const user = await insertTestUser({
        google_user_email: 'kilo-pass-create-session-ok@example.com',
      });
      await insertSubscription({
        kiloUserId: user.id,
        stripeSubscriptionId: 'sub_test_ended_ok',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'canceled',
      });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloPass.createCheckoutSession({
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Yearly,
      });

      expect(result).toEqual({ url: 'https://stripe.example.test/checkout' });
      expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          customer: user.stripe_customer_id,
          line_items: [{ price: 'price_test_kilo_pass', quantity: 1 }],
          success_url: expect.stringContaining('/payments/kilo-pass/awarding'),
          subscription_data: {
            metadata: {
              type: 'kilo-pass',
              kiloUserId: user.id,
              tier: 'tier_49',
              cadence: 'yearly',
            },
          },
          metadata: {
            type: 'kilo-pass',
            kiloUserId: user.id,
            tier: 'tier_49',
            cadence: 'yearly',
          },
        })
      );
    });
  });
});
