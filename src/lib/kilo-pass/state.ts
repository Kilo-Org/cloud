import 'server-only';

import { kilo_pass_subscriptions } from '@kilocode/db/schema';

import type { DrizzleTransaction, db as defaultDb } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import { getOpenPauseEvent } from '@/lib/kilo-pass/pause-events';

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

export type KiloPassSubscriptionState = {
  subscriptionId: string;
  stripeSubscriptionId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  status: Stripe.Subscription.Status;
  cancelAtPeriodEnd: boolean;
  currentStreakMonths: number;
  nextYearlyIssueAt: string | null;
  startedAt: string | null;
  resumesAt: string | null;
};

type KiloPassSubscriptionRowForState = {
  subscriptionId: string;
  stripeSubscriptionId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  status: Stripe.Subscription.Status;
  cancelAtPeriodEnd: boolean;
  currentStreakMonths: number;
  nextYearlyIssueAt: string | null;
  startedAt: string | null;
  createdAt: string;
};

function isoToMillis(iso: string | null): number | null {
  if (!iso) return null;

  const parsed = dayjs(iso);
  if (!parsed.isValid()) return null;
  return parsed.valueOf();
}

function normalizeTimestampToIso(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const millis = isoToMillis(timestamp);
  if (millis === null) return timestamp;
  return dayjs(millis).utc().toISOString();
}

function getSubscriptionRecencyMillis(subscription: KiloPassSubscriptionRowForState): number {
  return (
    isoToMillis(subscription.startedAt) ??
    isoToMillis(subscription.createdAt) ??
    Number.NEGATIVE_INFINITY
  );
}

/**
 * Determines the priority of a subscription status for selection.
 * Lower number = higher priority.
 * Active subscriptions are preferred, then pending cancellation, then ended.
 */
function getStatusPriority(row: KiloPassSubscriptionRowForState): number {
  // Active and not pending cancellation is highest priority
  if (row.status === 'active' && !row.cancelAtPeriodEnd) return 0;
  // Active but pending cancellation
  if (row.status === 'active' && row.cancelAtPeriodEnd) return 1;
  // Trialing is also considered active-ish
  if (row.status === 'trialing') return 2;
  // Past due - still has access but payment issues
  if (row.status === 'past_due') return 3;
  // Paused
  if (row.status === 'paused') return 4;
  // Incomplete - initial payment pending
  if (row.status === 'incomplete') return 5;
  // Ended states
  if (isStripeSubscriptionEnded(row.status)) return 6;
  // Fallback for any unknown status
  return 7;
}

function pickSubscriptionForState(
  subscriptions: readonly KiloPassSubscriptionRowForState[]
): KiloPassSubscriptionRowForState | null {
  if (subscriptions.length === 0) return null;

  // Sort by priority first, then by recency within same priority
  const sorted = [...subscriptions].sort((a, b) => {
    const priorityDiff = getStatusPriority(a) - getStatusPriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return getSubscriptionRecencyMillis(b) - getSubscriptionRecencyMillis(a);
  });

  return sorted[0] ?? null;
}

export async function getKiloPassStateForUser(
  db: DbOrTx,
  kiloUserId: string
): Promise<KiloPassSubscriptionState | null> {
  const subscriptions = await db
    .select({
      subscriptionId: kilo_pass_subscriptions.id,
      stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
      tier: kilo_pass_subscriptions.tier,
      cadence: kilo_pass_subscriptions.cadence,
      status: kilo_pass_subscriptions.status,
      cancelAtPeriodEnd: kilo_pass_subscriptions.cancel_at_period_end,
      currentStreakMonths: kilo_pass_subscriptions.current_streak_months,
      nextYearlyIssueAt: kilo_pass_subscriptions.next_yearly_issue_at,
      startedAt: kilo_pass_subscriptions.started_at,
      createdAt: kilo_pass_subscriptions.created_at,
    })
    .from(kilo_pass_subscriptions)
    .where(eq(kilo_pass_subscriptions.kilo_user_id, kiloUserId));

  const selected = pickSubscriptionForState(subscriptions);
  if (!selected) return null;

  // Check for an open pause event. Stripe keeps status 'active' when pause_collection
  // is first set (the status changes to 'paused' only at the next billing cycle), so we
  // derive the paused state from the pause event table rather than the DB status.
  const openPause = await getOpenPauseEvent(db, {
    kiloPassSubscriptionId: selected.subscriptionId,
  });
  const isPaused = openPause != null;
  const resumesAt =
    isPaused && openPause.resumes_at ? normalizeTimestampToIso(openPause.resumes_at) : null;

  return {
    subscriptionId: selected.subscriptionId,
    stripeSubscriptionId: selected.stripeSubscriptionId,
    tier: selected.tier,
    cadence: selected.cadence,
    status: isPaused ? 'paused' : selected.status,
    cancelAtPeriodEnd: selected.cancelAtPeriodEnd,
    currentStreakMonths: selected.currentStreakMonths,
    nextYearlyIssueAt: normalizeTimestampToIso(selected.nextYearlyIssueAt),
    startedAt: normalizeTimestampToIso(selected.startedAt),
    resumesAt,
  };
}
