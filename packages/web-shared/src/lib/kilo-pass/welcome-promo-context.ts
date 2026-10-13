import 'server-only';

import { kilo_pass_issuances, kilo_pass_subscriptions } from '@kilocode/db/schema';
import { and, asc, eq, ne } from 'drizzle-orm';

import type { DrizzleTransaction, db as defaultDb } from '@kilocode/web-shared/lib/drizzle';
import {
  KiloPassPaymentProvider,
  type KiloPassWelcomePromoEligibilityReason,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { KILO_PASS_WELCOME_PROMO_FINGERPRINT_POLICY_ROLLOUT } from '@kilocode/web-shared/lib/kilo-pass/constants';
import { dayjs } from '@kilocode/web-shared/lib/kilo-pass/dayjs';

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

export type KiloPassWelcomePromoPolicy = 'account-history-only' | 'settled-payment-required';

export type InitialWelcomePromoContext = {
  createdAt: string;
  eligibilityReason: KiloPassWelcomePromoEligibilityReason | null;
};

export function getKiloPassWelcomePromoPolicy(params: {
  paymentProvider: KiloPassPaymentProvider;
  initialIssuanceCreatedAt: string | null;
}): KiloPassWelcomePromoPolicy {
  if (params.paymentProvider !== KiloPassPaymentProvider.Stripe) {
    return 'account-history-only';
  }

  if (params.initialIssuanceCreatedAt == null) return 'settled-payment-required';

  const initialIssuanceCreatedAt = dayjs(params.initialIssuanceCreatedAt).utc();
  return initialIssuanceCreatedAt.isValid() &&
    initialIssuanceCreatedAt.isBefore(KILO_PASS_WELCOME_PROMO_FINGERPRINT_POLICY_ROLLOUT)
    ? 'account-history-only'
    : 'settled-payment-required';
}

export async function getInitialWelcomePromoContextForSubscription(
  db: DbOrTx,
  params: { subscriptionId: string }
): Promise<InitialWelcomePromoContext | null> {
  const initialIssuance = await db
    .select({
      createdAt: kilo_pass_issuances.created_at,
      eligibilityReason: kilo_pass_issuances.initial_welcome_promo_eligibility_reason,
    })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, params.subscriptionId))
    .orderBy(asc(kilo_pass_issuances.issue_month))
    .limit(1);

  return initialIssuance[0] ?? null;
}

export type MonthlyWelcomePromoAccountContext = {
  isFirstTimeSubscriberEver: boolean;
  welcomePromoPolicy: KiloPassWelcomePromoPolicy;
  welcomePromoEligibilityReason: KiloPassWelcomePromoEligibilityReason | null;
};

export async function getMonthlyWelcomePromoAccountContext(
  db: DbOrTx,
  params: {
    kiloUserId: string;
    subscriptionId: string;
    paymentProvider: KiloPassPaymentProvider;
  }
): Promise<MonthlyWelcomePromoAccountContext> {
  const otherSubscription = await db
    .select({ id: kilo_pass_subscriptions.id })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.kilo_user_id, params.kiloUserId),
        ne(kilo_pass_subscriptions.id, params.subscriptionId)
      )
    )
    .limit(1);
  const initialWelcomePromoContext =
    params.paymentProvider === KiloPassPaymentProvider.Stripe
      ? await getInitialWelcomePromoContextForSubscription(db, {
          subscriptionId: params.subscriptionId,
        })
      : null;

  return {
    isFirstTimeSubscriberEver: otherSubscription.length === 0,
    welcomePromoPolicy: getKiloPassWelcomePromoPolicy({
      paymentProvider: params.paymentProvider,
      initialIssuanceCreatedAt: initialWelcomePromoContext?.createdAt ?? null,
    }),
    welcomePromoEligibilityReason: initialWelcomePromoContext?.eligibilityReason ?? null,
  };
}
