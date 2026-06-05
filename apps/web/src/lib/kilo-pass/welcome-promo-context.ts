import 'server-only';

import { kilo_pass_issuances } from '@kilocode/db/schema';
import { asc, eq } from 'drizzle-orm';

import type { DrizzleTransaction, db as defaultDb } from '@/lib/drizzle';
import type { KiloPassWelcomePromoEligibilityReason } from '@/lib/kilo-pass/enums';

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

export async function getInitialWelcomePromoEligibilityReasonForSubscription(
  db: DbOrTx,
  params: { subscriptionId: string }
): Promise<KiloPassWelcomePromoEligibilityReason | null> {
  const initialIssuance = await db
    .select({
      welcomePromoEligibilityReason: kilo_pass_issuances.initial_welcome_promo_eligibility_reason,
    })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, params.subscriptionId))
    .orderBy(asc(kilo_pass_issuances.issue_month))
    .limit(1);

  return initialIssuance[0]?.welcomePromoEligibilityReason ?? null;
}
