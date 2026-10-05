import 'server-only';

import { kilo_pass_issuances } from '@kilocode/db/schema';
import { asc, eq } from 'drizzle-orm';

import type { DrizzleTransaction, db as defaultDb } from '@/lib/drizzle';
import {
  KiloPassPaymentProvider,
  type KiloPassWelcomePromoEligibilityReason,
} from '@/lib/kilo-pass/enums';
import { KILO_PASS_WELCOME_PROMO_FINGERPRINT_POLICY_ROLLOUT } from '@/lib/kilo-pass/constants';
import { dayjs } from '@/lib/kilo-pass/dayjs';

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
