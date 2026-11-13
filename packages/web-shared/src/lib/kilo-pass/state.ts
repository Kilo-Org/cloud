import 'server-only';

import { kilo_pass_store_purchases, kilo_pass_subscriptions } from '@kilocode/db/schema';
import type { StripeSubscriptionStatus } from '@kilocode/db/schema-types';

import type { DrizzleTransaction, db as defaultDb } from '@kilocode/web-shared/lib/drizzle';
import { and, desc, eq } from 'drizzle-orm';
import {
  type KiloPassPaymentProvider,
  KiloPassPaymentProvider as KiloPassPaymentProviderValue,
  type KiloPassCadence,
  type KiloPassTier,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { isStripeSubscriptionEnded } from '@kilocode/web-shared/lib/kilo-pass/stripe-subscription-status';
import { dayjs } from '@kilocode/web-shared/lib/kilo-pass/dayjs';
import { getOpenPauseEvent } from '@kilocode/web-shared/lib/kilo-pass/pause-events';
import { pickKiloPassSubscriptionForProjection } from '@kilocode/worker-utils/kilo-pass-bonus-projection';

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

export type KiloPassSubscriptionState = {
  subscriptionId: string;
  stripeSubscriptionId: string | null;
  paymentProvider: KiloPassPaymentProvider;
  providerSubscriptionId: string | null;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  status: StripeSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentStreakMonths: number;
  nextYearlyIssueAt: string | null;
  startedAt: string | null;
  resumesAt: string | null;
};

type KiloPassSubscriptionRowForState = {
  subscriptionId: string;
  stripeSubscriptionId: string | null;
  paymentProvider: KiloPassPaymentProvider;
  providerSubscriptionId: string | null;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  status: StripeSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentStreakMonths: number;
  nextYearlyIssueAt: string | null;
  startedAt: string | null;
  createdAt: string;
};

function toKiloPassSubscriptionState(
  selected: KiloPassSubscriptionRowForState,
  overrides: Pick<KiloPassSubscriptionState, 'status' | 'cancelAtPeriodEnd' | 'resumesAt'>
): KiloPassSubscriptionState {
  return {
    subscriptionId: selected.subscriptionId,
    stripeSubscriptionId: selected.stripeSubscriptionId,
    paymentProvider: selected.paymentProvider,
    providerSubscriptionId: selected.providerSubscriptionId,
    tier: selected.tier,
    cadence: selected.cadence,
    status: overrides.status,
    cancelAtPeriodEnd: overrides.cancelAtPeriodEnd,
    currentStreakMonths: selected.currentStreakMonths,
    nextYearlyIssueAt: normalizeTimestampToIso(selected.nextYearlyIssueAt),
    startedAt: normalizeTimestampToIso(selected.startedAt),
    resumesAt: overrides.resumesAt,
  };
}

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

function isStoreManagedProvider(paymentProvider: KiloPassPaymentProvider): boolean {
  return paymentProvider !== KiloPassPaymentProviderValue.Stripe;
}

function isExpiredAtOrBeforeNow(expiresAt: string | null, nowIso: string): boolean {
  const expiresAtMillis = isoToMillis(expiresAt);
  const nowMillis = isoToMillis(nowIso);
  return expiresAtMillis !== null && nowMillis !== null && expiresAtMillis <= nowMillis;
}

export async function getKiloPassStateForUser(
  db: DbOrTx,
  kiloUserId: string,
  options: { forUpdate?: boolean } = {}
): Promise<KiloPassSubscriptionState | null> {
  const subscriptionQuery = db
    .select({
      subscriptionId: kilo_pass_subscriptions.id,
      stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
      paymentProvider: kilo_pass_subscriptions.payment_provider,
      providerSubscriptionId: kilo_pass_subscriptions.provider_subscription_id,
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
  const subscriptions = options.forUpdate
    ? await subscriptionQuery.for('update')
    : await subscriptionQuery;

  const selected = pickKiloPassSubscriptionForProjection(subscriptions);
  if (!selected) return null;

  if (isStoreManagedProvider(selected.paymentProvider)) {
    const latestStorePurchase = await db.query.kilo_pass_store_purchases.findFirst({
      where: and(
        eq(kilo_pass_store_purchases.kilo_pass_subscription_id, selected.subscriptionId),
        eq(kilo_pass_store_purchases.payment_provider, selected.paymentProvider)
      ),
      orderBy: desc(kilo_pass_store_purchases.purchased_at),
    });
    const nowIso = dayjs().utc().toISOString();

    // Store subscriptions are historical: notifications no longer change their
    // rows, so derive canceled from the last recorded expiry without writing.
    if (isExpiredAtOrBeforeNow(latestStorePurchase?.expires_at ?? null, nowIso)) {
      return toKiloPassSubscriptionState(selected, {
        status: 'canceled',
        cancelAtPeriodEnd: false,
        resumesAt: null,
      });
    }
  }

  // Check for an open pause event. Stripe keeps status 'active' when pause_collection
  // is first set (the status changes to 'paused' only at the next billing cycle), so we
  // derive the paused state from the pause event table rather than the DB status.
  const openPause = isStripeSubscriptionEnded(selected.status)
    ? null
    : await getOpenPauseEvent(db, { kiloPassSubscriptionId: selected.subscriptionId });
  const isPaused = openPause != null;
  const resumesAt =
    isPaused && openPause.resumes_at ? normalizeTimestampToIso(openPause.resumes_at) : null;

  return toKiloPassSubscriptionState(selected, {
    status: isPaused ? 'paused' : selected.status,
    cancelAtPeriodEnd: selected.cancelAtPeriodEnd,
    resumesAt,
  });
}
