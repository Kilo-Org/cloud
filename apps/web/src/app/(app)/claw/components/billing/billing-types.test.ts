import { deriveBannerState, deriveLockReason, type ClawBillingStatus } from './billing-types';

type BillingStatusOverrides = Omit<Partial<ClawBillingStatus>, 'subscription' | 'instance'> & {
  subscription?: Partial<NonNullable<ClawBillingStatus['subscription']>> | null;
  instance?: Partial<NonNullable<ClawBillingStatus['instance']>> | null;
};

function createBillingStatus(overrides?: BillingStatusOverrides): ClawBillingStatus {
  const {
    subscription: subscriptionOverrides,
    instance: instanceOverrides,
    ...rootOverrides
  } = overrides ?? {};

  return {
    hasAccess: false,
    accessReason: null,
    trialEligible: false,
    creditBalanceMicrodollars: 0,
    creditIntroEligible: false,
    hasActiveKiloPass: false,
    creditEnrollmentPreview: {
      standard: {
        costMicrodollars: 4_000_000,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
      },
      commit: {
        costMicrodollars: 48_000_000,
        projectedKiloPassBonusMicrodollars: 0,
        effectiveBalanceMicrodollars: 0,
      },
    },
    trial: null,
    subscription:
      subscriptionOverrides === null
        ? null
        : {
            plan: 'standard',
            status: 'active',
            activationState: 'activated',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: '2026-05-01T00:00:00.000Z',
            commitEndsAt: null,
            scheduledPlan: null,
            scheduledBy: null,
            hasStripeFunding: true,
            paymentSource: 'stripe',
            creditRenewalAt: null,
            renewalCostMicrodollars: null,
            showConversionPrompt: false,
            pendingConversion: false,
            ...subscriptionOverrides,
          },
    earlybird: null,
    instance:
      instanceOverrides === null
        ? null
        : {
            id: 'instance-1',
            exists: true,
            status: null,
            suspendedAt: null,
            destructionDeadline: null,
            destroyed: false,
            ...instanceOverrides,
          },
    ...rootOverrides,
  };
}

describe('billing-types pending settlement compatibility', () => {
  it('does not show subscribed banner before settlement completes', () => {
    const billing = createBillingStatus({
      subscription: {
        activationState: 'pending_settlement',
        status: 'active',
      },
    });

    expect(deriveBannerState(billing)).toBe('none');
  });

  it('does not show access lock before settlement completes', () => {
    const billing = createBillingStatus({
      subscription: {
        activationState: 'pending_settlement',
        status: 'active',
      },
    });

    expect(deriveLockReason(billing)).toBeNull();
  });
});
