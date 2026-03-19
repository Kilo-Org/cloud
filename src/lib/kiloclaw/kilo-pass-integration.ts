import 'server-only';

import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq, sql } from 'drizzle-orm';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { computeMonthlyCadenceBonusPercent } from '@/lib/kilo-pass/bonus';
import { KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT } from '@/lib/kilo-pass/constants';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import { sentryLogger } from '@/lib/utils.server';

const logError = sentryLogger('kiloclaw-kilo-pass', 'error');

function computeBonusPercent(
  state: NonNullable<Awaited<ReturnType<typeof getKiloPassStateForUser>>>
): number {
  if (state.cadence === KiloPassCadence.Yearly) {
    return KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT;
  }

  // isFirstTimeSubscriberEver=false is a conservative estimate that may
  // undercount the bonus for users in the first-time 50% promo window.
  // This is intentional: the projection is used for balance sufficiency
  // checks, so under-projecting can cause a "try again later" rather than
  // enrolling into a negative balance. A future iteration could query the
  // subscription history for exact first-time status.
  return computeMonthlyCadenceBonusPercent({
    tier: state.tier,
    streakMonths: Math.max(1, state.currentStreakMonths),
    isFirstTimeSubscriberEver: false,
    subscriptionStartedAtIso: state.startedAt,
  });
}

/**
 * Returns the projected bonus in microdollars that a user would receive from
 * their Kilo Pass entitlement for a deduction of the given amount.
 * Returns 0 when the user has no active Kilo Pass.
 */
export async function getProjectedKiloPassBonus(
  userId: string,
  deductionMicrodollars: number
): Promise<number> {
  try {
    const state = await getKiloPassStateForUser(db, userId);
    if (!state || state.status !== 'active') return 0;

    const bonusPercent = computeBonusPercent(state);
    return Math.round(deductionMicrodollars * bonusPercent);
  } catch (error) {
    logError('getProjectedKiloPassBonus failed', { userId, deductionMicrodollars, error });
    return 0;
  }
}

/**
 * After a credit deduction commits, evaluates whether the user's Kilo Pass
 * entitlement qualifies them for bonus credits and awards them if so.
 * No-op when the user has no active Kilo Pass. Failures are logged but never thrown.
 */
export async function evaluateKiloPassBonusAfterDeduction(
  userId: string,
  deductionMicrodollars: number
): Promise<void> {
  try {
    const state = await getKiloPassStateForUser(db, userId);
    if (!state || state.status !== 'active') return;

    const bonusPercent = computeBonusPercent(state);
    const bonusMicrodollars = Math.round(deductionMicrodollars * bonusPercent);
    if (bonusMicrodollars <= 0) return;

    await db.insert(credit_transactions).values({
      kilo_user_id: userId,
      is_free: true,
      amount_microdollars: bonusMicrodollars,
      description: `KiloClaw Kilo Pass bonus (${state.cadence}, ${state.tier})`,
      credit_category: 'kiloclaw-kilo-pass-bonus',
      check_category_uniqueness: false,
    });

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${bonusMicrodollars}`,
      })
      .where(eq(kilocode_users.id, userId));
  } catch (error) {
    logError('evaluateKiloPassBonusAfterDeduction failed', {
      userId,
      deductionMicrodollars,
      error,
    });
  }
}
