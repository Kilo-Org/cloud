import { describe, expect, it } from 'vitest';

import { deriveMobileOnboardingStateFromBilling } from '@/lib/derive-mobile-onboarding-state';
import { type ClawBillingStatus } from '@/lib/hooks/use-kiloclaw-billing';

const emptyKiloPassUpsellPreview: ClawBillingStatus['kiloPassUpsellPreview'] = {
  commit: {
    monthly: {
      '19': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
      '49': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
      '199': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
    },
    yearly: {
      '19': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
      '49': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
      '199': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
    },
  },
  standard: {
    monthly: {
      '19': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
      '49': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
      '199': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
    },
    yearly: {
      '19': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
      '49': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
      '199': {
        costMicrodollars: 0,
        eligible: false,
        projectedKiloPassBaseMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        shortfallMicrodollars: 0,
      },
    },
  },
};

function billingStatus(overrides: Partial<ClawBillingStatus> = {}): ClawBillingStatus {
  return {
    accessReason: null,
    commitPlanAvailable: false,
    creditBalanceMicrodollars: 0,
    creditEnrollmentPreview: {
      commit: {
        costMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
      },
      standard: {
        costMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
        projectedKiloPassBonusMicrodollars: 0,
      },
    },
    creditIntroEligible: false,
    creditReprovisionRecovery: {
      costMicrodollars: 0,
      effectiveBalanceMicrodollars: 0,
      eligible: false,
      plan: 'standard',
      projectedKiloPassBonusMicrodollars: 0,
      shortfallMicrodollars: 0,
    },
    earlybird: null,
    hasAccess: false,
    hasActiveKiloPass: false,
    hasExistingPersonalSubscription: false,
    hasCurrentPersonalSubscription: false,
    instance: null,
    intendedPriceVersion: '2026-05-10',
    intendedSelfServiceInstanceType: 'perf-1-3',
    kiloPassUpsellPreview: emptyKiloPassUpsellPreview,
    subscription: null,
    trial: null,
    trialEligible: true,
    ...overrides,
  };
}

describe('deriveMobileOnboardingStateFromBilling', () => {
  it('closes fresh mobile signup even when the legacy trial flag is true', () => {
    expect(deriveMobileOnboardingStateFromBilling(billingStatus())).toEqual({
      state: 'signup_unavailable',
    });
  });

  it('blocks recovery for historical subscribers without a current subscription', () => {
    expect(
      deriveMobileOnboardingStateFromBilling(
        billingStatus({
          hasExistingPersonalSubscription: true,
          hasCurrentPersonalSubscription: false,
          trialEligible: false,
        })
      )
    ).toEqual({ state: 'signup_unavailable' });
  });
});
