import { db } from '@/lib/drizzle';
import { kiloclaw_subscriptions, type KiloClawSubscription } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export type KiloClawAccessReason = 'trial' | 'subscription';

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function subscriptionPriority(subscription: KiloClawSubscription, now: Date): number {
  const accessReason = getKiloClawSubscriptionAccessReason(subscription, now);
  if (accessReason === 'subscription') return 0;
  if (accessReason === 'trial') return 1;
  if (subscription.plan !== 'trial') return 2;
  if (subscription.status === 'trialing') return 3;
  return 4;
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
  subscription:
    | Pick<KiloClawSubscription, 'status' | 'trial_ends_at' | 'suspended_at'>
    | null
    | undefined,
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
