import { db } from '@/lib/drizzle';
import { KILOCLAW_EARLYBIRD_EXPIRY_DATE } from '@/lib/kiloclaw/constants';
import {
  kiloclaw_earlybird_purchases,
  kiloclaw_subscriptions,
  type KiloClawSubscription,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import {
  CurrentPersonalSubscriptionResolutionError,
  resolveCurrentPersonalSubscriptionRow,
} from '@/lib/kiloclaw/current-personal-subscription';

export type KiloClawAccessReason = 'trial' | 'subscription' | 'earlybird';
export type KiloClawSubscriptionAccessRecord = Pick<
  KiloClawSubscription,
  'status' | 'trial_ends_at' | 'suspended_at' | 'access_origin'
>;
export type KiloClawEarlybirdState = {
  purchased: boolean;
  hasAccess: boolean;
  expiresAt: string | null;
};

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function subscriptionPriority(subscription: KiloClawSubscription, now: Date): number {
  const accessReason = getKiloClawSubscriptionAccessReason(subscription, now);
  if (accessReason === 'subscription') return 0;
  if (accessReason === 'trial') return 1;
  if (accessReason === 'earlybird') return 2;
  if (subscription.plan !== 'trial') return 3;
  if (subscription.status === 'trialing') return 4;
  return 5;
}

function subscriptionRecency(subscription: KiloClawSubscription): number {
  return Math.max(
    parseTimestamp(subscription.current_period_end),
    parseTimestamp(subscription.trial_ends_at),
    parseTimestamp(subscription.updated_at),
    parseTimestamp(subscription.created_at)
  );
}

export function getKiloClawSubscriptionAccessReason(
  subscription: KiloClawSubscriptionAccessRecord | null | undefined,
  now = new Date()
): KiloClawAccessReason | null {
  if (!subscription) return null;
  if (subscription.status === 'active') return 'subscription';
  if (subscription.status === 'past_due' && !subscription.suspended_at) return 'subscription';
  if (
    subscription.status === 'trialing' &&
    subscription.trial_ends_at &&
    new Date(subscription.trial_ends_at) > now
  ) {
    if (subscription.access_origin === 'earlybird') {
      return 'earlybird';
    }
    return 'trial';
  }
  return null;
}

export function getEffectiveKiloClawSubscription(
  subscriptions: KiloClawSubscription[],
  now = new Date()
): KiloClawSubscription | null {
  if (subscriptions.length === 0) return null;

  return [...subscriptions].sort((left, right) => {
    const priorityDiff = subscriptionPriority(left, now) - subscriptionPriority(right, now);
    if (priorityDiff !== 0) return priorityDiff;

    const recencyDiff = subscriptionRecency(right) - subscriptionRecency(left);
    if (recencyDiff !== 0) return recencyDiff;

    return right.id.localeCompare(left.id);
  })[0];
}

export async function getEffectiveKiloClawSubscriptionForUser(
  userId: string,
  now = new Date()
): Promise<{
  subscription: KiloClawSubscription | null;
  accessReason: KiloClawAccessReason | null;
  subscriptionCount: number;
}> {
  const subscriptions = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, userId));

  const subscription = getEffectiveKiloClawSubscription(subscriptions, now);
  return {
    subscription,
    accessReason: getKiloClawSubscriptionAccessReason(subscription, now),
    subscriptionCount: subscriptions.length,
  };
}

export async function getKiloClawEarlybirdStateForUser(
  userId: string,
  now = new Date()
): Promise<KiloClawEarlybirdState> {
  const earlybirdSubscriptions = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        eq(kiloclaw_subscriptions.access_origin, 'earlybird')
      )
    );

  if (earlybirdSubscriptions.length > 0) {
    const subscription = getEffectiveKiloClawSubscription(earlybirdSubscriptions, now);
    return {
      purchased: true,
      hasAccess: getKiloClawSubscriptionAccessReason(subscription, now) === 'earlybird',
      expiresAt: subscription?.trial_ends_at ?? KILOCLAW_EARLYBIRD_EXPIRY_DATE,
    };
  }

  const [legacyPurchase] = await db
    .select({ createdAt: kiloclaw_earlybird_purchases.created_at })
    .from(kiloclaw_earlybird_purchases)
    .where(eq(kiloclaw_earlybird_purchases.user_id, userId))
    .limit(1);

  if (legacyPurchase) {
    return {
      purchased: true,
      hasAccess: new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE) > now,
      expiresAt: KILOCLAW_EARLYBIRD_EXPIRY_DATE,
    };
  }

  return {
    purchased: false,
    hasAccess: false,
    expiresAt: null,
  };
}

export async function getCurrentPersonalKiloClawSubscriptionForUser(
  userId: string,
  now = new Date()
): Promise<{
  subscription: KiloClawSubscription | null;
  accessReason: KiloClawAccessReason | null;
}> {
  const row = await resolveCurrentPersonalSubscriptionRow({ userId, dbOrTx: db });
  const subscription = row?.subscription ?? null;
  return {
    subscription,
    accessReason: getKiloClawSubscriptionAccessReason(subscription, now),
  };
}

export { CurrentPersonalSubscriptionResolutionError };
