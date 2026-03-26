import { parseTimestamp } from '@/lib/utils';

import { type useKiloClawBillingStatus } from './use-kiloclaw';

type ClawBillingStatus = NonNullable<ReturnType<typeof useKiloClawBillingStatus>['data']>;

type ClawBannerState =
  | 'trial_active'
  | 'trial_ending_soon'
  | 'trial_ending_very_soon'
  | 'trial_expires_today'
  | 'earlybird_active'
  | 'earlybird_ending_soon'
  | 'subscription_canceling'
  | 'subscription_past_due'
  | 'subscribed'
  | 'none';

type ClawLockReason =
  | 'trial_expired_instance_alive'
  | 'trial_expired_instance_destroyed'
  | 'earlybird_expired'
  | 'subscription_expired_instance_alive'
  | 'subscription_expired_instance_destroyed'
  | 'past_due_grace_exceeded'
  | 'no_access'
  | undefined;

export type { ClawBillingStatus };

function deriveSubscriptionBannerState(
  subscription: NonNullable<ClawBillingStatus['subscription']>
): ClawBannerState | undefined {
  if (subscription.status === 'past_due' || subscription.status === 'unpaid') {
    return 'subscription_past_due';
  }
  if (subscription.cancelAtPeriodEnd) {
    return 'subscription_canceling';
  }
  if (subscription.status === 'active') {
    return 'subscribed';
  }
  return undefined;
}

function deriveTrialBannerState(
  trial: NonNullable<ClawBillingStatus['trial']>
): ClawBannerState | undefined {
  if (trial.expired) {
    return undefined;
  }
  const d = trial.daysRemaining;
  if (d === 0) {
    return 'trial_expires_today';
  }
  if (d <= 1) {
    return 'trial_ending_very_soon';
  }
  if (d <= 2) {
    return 'trial_ending_soon';
  }
  return 'trial_active';
}

function deriveEarlybirdBannerState(
  earlybird: NonNullable<ClawBillingStatus['earlybird']>
): ClawBannerState {
  if (earlybird.daysRemaining <= 0) {
    return 'none';
  }
  if (earlybird.daysRemaining <= 30) {
    return 'earlybird_ending_soon';
  }
  return 'earlybird_active';
}

export function deriveBannerState(billing: ClawBillingStatus): ClawBannerState {
  if (billing.subscription) {
    const state = deriveSubscriptionBannerState(billing.subscription);
    if (state) {
      return state;
    }
  }
  if (billing.trial) {
    const state = deriveTrialBannerState(billing.trial);
    if (state) {
      return state;
    }
  }
  if (billing.earlybird) {
    return deriveEarlybirdBannerState(billing.earlybird);
  }
  return 'none';
}

function deriveSubscriptionLockReason(billing: ClawBillingStatus): ClawLockReason {
  const sub = billing.subscription;
  if (sub?.status === 'canceled') {
    return billing.instance?.destroyed
      ? 'subscription_expired_instance_destroyed'
      : 'subscription_expired_instance_alive';
  }
  if (sub?.status === 'past_due' || sub?.status === 'unpaid') {
    return 'past_due_grace_exceeded';
  }
  return undefined;
}

export function deriveLockReason(billing: ClawBillingStatus): ClawLockReason {
  if (billing.hasAccess) {
    return undefined;
  }

  const subReason = deriveSubscriptionLockReason(billing);
  if (subReason) {
    return subReason;
  }

  if (billing.trial?.expired) {
    return billing.instance?.destroyed
      ? 'trial_expired_instance_destroyed'
      : 'trial_expired_instance_alive';
  }
  if (billing.earlybird && billing.earlybird.daysRemaining <= 0) {
    return 'earlybird_expired';
  }
  if (billing.instance) {
    return 'no_access';
  }
  return undefined;
}

export function formatBillingDate(iso: string): string {
  return parseTimestamp(iso).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
