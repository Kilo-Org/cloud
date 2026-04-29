import { type ClawBillingStatus } from '@/lib/hooks/use-kiloclaw-billing';

/**
 * Client-side derivation of the mobile KiloClaw onboarding facade.
 *
 * Composes the already-deployed `kiloclaw.getBillingStatus` response into a
 * single discriminated-union state that the native onboarding flow branches on.
 *
 * Limitations vs. a hypothetical server derivation:
 *   - `multiple_current_conflict` is server-only (fail-closed on >1 current sub rows).
 *   - `non_canonical_earlybird` requires the legacy earlybird purchases table.
 *   Both fall through to `access_required` here, which is the closest UX match.
 */

export type MobileOnboardingState =
  | { state: 'trial_eligible' }
  | {
      state: 'has_access';
      accessReason: 'trial' | 'subscription' | 'earlybird';
      instanceId: string | null;
    }
  | { state: 'pending_settlement'; instanceId: string | null }
  | {
      state: 'access_required';
      reason: 'trial_expired' | 'subscription_canceled' | 'subscription_past_due';
      instanceId: string | null;
    }
  | { state: 'quarantined'; instanceId: string }
  | { state: 'multiple_current_conflict' }
  | { state: 'non_canonical_earlybird' };

type AccessRequiredReason = Extract<MobileOnboardingState, { state: 'access_required' }>['reason'];

export function deriveMobileOnboardingStateFromBilling(
  billing: ClawBillingStatus
): MobileOnboardingState {
  const liveInstanceId = billing.instance?.exists ? billing.instance.id : null;

  if (billing.hasAccess && billing.accessReason) {
    return {
      state: 'has_access',
      accessReason: billing.accessReason,
      instanceId: liveInstanceId,
    };
  }

  if (billing.subscription?.activationState === 'pending_settlement') {
    return { state: 'pending_settlement', instanceId: liveInstanceId };
  }

  if (liveInstanceId && !billing.subscription) {
    return { state: 'quarantined', instanceId: liveInstanceId };
  }

  if (billing.trialEligible) {
    return { state: 'trial_eligible' };
  }

  return {
    state: 'access_required',
    reason: deriveAccessRequiredReason(billing),
    instanceId: liveInstanceId,
  };
}

function deriveAccessRequiredReason(billing: ClawBillingStatus): AccessRequiredReason {
  const subscription = billing.subscription;
  if (subscription?.status === 'past_due' || subscription?.status === 'unpaid') {
    return 'subscription_past_due';
  }
  if (billing.trial?.expired) {
    return 'trial_expired';
  }
  return 'subscription_canceled';
}
