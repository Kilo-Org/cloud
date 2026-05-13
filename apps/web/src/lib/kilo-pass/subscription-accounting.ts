import { kilo_pass_issuances, kilocode_users } from '@kilocode/db/schema';
import { and, desc, eq, lte, sql } from 'drizzle-orm';

import type { DrizzleTransaction } from '@/lib/drizzle';
import { toMicrodollars } from '@/lib/utils';
import { getPausedMonthSet } from './pause-events';
import { getPreviousIssueMonth } from './stripe-handlers-utils';

export async function updateKiloPassThresholdAfterBaseCredits(
  tx: DrizzleTransaction,
  params: {
    kiloUserId: string;
    baseAmountUsd: number;
  }
): Promise<void> {
  await tx
    .update(kilocode_users)
    .set({
      kilo_pass_threshold: sql`${kilocode_users.microdollars_used} + ${toMicrodollars(
        params.baseAmountUsd
      )}`,
    })
    .where(eq(kilocode_users.id, params.kiloUserId));
}

export async function computeMonthlyKiloPassStreak(
  tx: DrizzleTransaction,
  params: {
    subscriptionId: string;
    issueMonth: string;
    maxMonthsBack?: number;
  }
): Promise<number> {
  const maxMonthsBack = params.maxMonthsBack ?? 36;
  const monthlyIssuanceMonths = await tx
    .select({ issueMonth: kilo_pass_issuances.issue_month })
    .from(kilo_pass_issuances)
    .where(
      and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, params.subscriptionId),
        lte(kilo_pass_issuances.issue_month, params.issueMonth)
      )
    )
    .orderBy(desc(kilo_pass_issuances.issue_month))
    .limit(maxMonthsBack);

  const issueMonthSet = new Set(monthlyIssuanceMonths.map(row => row.issueMonth));
  const pausedMonthSet = await getPausedMonthSet(tx, {
    kiloPassSubscriptionId: params.subscriptionId,
    fromIssueMonth: params.issueMonth,
    maxMonthsBack,
  });

  let computedStreak = 0;
  let cursor = params.issueMonth;
  let iterations = 0;
  while (iterations < maxMonthsBack) {
    if (issueMonthSet.has(cursor)) {
      computedStreak += 1;
      cursor = getPreviousIssueMonth(cursor);
    } else if (pausedMonthSet.has(cursor)) {
      cursor = getPreviousIssueMonth(cursor);
    } else {
      break;
    }
    iterations += 1;
  }

  return Math.max(1, computedStreak);
}
