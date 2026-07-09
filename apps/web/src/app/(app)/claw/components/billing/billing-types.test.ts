import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createKiloClawSignupDisplay,
  deriveBannerState,
  deriveLockReason,
  formatKiloClawPlanPrice,
  getKiloClawFundingChoiceCopy,
  getKiloClawRetirementDisplay,
  getKiloPassHostingRecoveryCopy,
  type ClawBillingStatus,
  type KiloPassUpsellActivationPreview,
} from './billing-types';
import { BillingBanner } from './BillingBanner';

const emptyUpsellPreview: KiloPassUpsellActivationPreview = {
  eligible: false,
  costMicrodollars: 0,
  projectedKiloPassBaseMicrodollars: 0,
  projectedKiloPassBonusMicrodollars: 0,
  effectiveBalanceMicrodollars: 0,
  shortfallMicrodollars: 0,
};

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
    intendedPriceVersion: '2026-05-10',
    intendedSelfServiceInstanceType: 'perf-1-3',
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
    creditReprovisionRecovery: {
      eligible: false,
      plan: 'standard',
      costMicrodollars: 55_000_000,
      projectedKiloPassBonusMicrodollars: 0,
      effectiveBalanceMicrodollars: 0,
      shortfallMicrodollars: 55_000_000,
    },
    kiloPassUpsellPreview: {
      standard: {
        monthly: { '19': emptyUpsellPreview, '49': emptyUpsellPreview, '199': emptyUpsellPreview },
        yearly: { '19': emptyUpsellPreview, '49': emptyUpsellPreview, '199': emptyUpsellPreview },
      },
      commit: {
        monthly: { '19': emptyUpsellPreview, '49': emptyUpsellPreview, '199': emptyUpsellPreview },
        yearly: { '19': emptyUpsellPreview, '49': emptyUpsellPreview, '199': emptyUpsellPreview },
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
            priceVersion: '2026-05-10',
            selfServiceInstanceType: 'perf-1-3',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: '2026-05-01T00:00:00.000Z',
            commitEndsAt: null,
            scheduledPlan: null,
            scheduledBy: null,
            hasStripeFunding: true,
            paymentSource: 'stripe',
            creditRenewalAt: null,
            renewalCostMicrodollars: null,
            renewalCostSource: null,
            showConversionPrompt: false,
            pendingConversion: false,
            referralRewards: {
              totalAppliedMonths: 0,
              applications: [],
            },
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

describe('KiloClaw billing display helpers', () => {
  it('formats current signup prices without a Standard intro offer', () => {
    const display = createKiloClawSignupDisplay({
      standardCostMicrodollars: 55_000_000,
      commitCostMicrodollars: 306_000_000,
    });

    expect(display.standard.primaryPrice).toBe('$55');
    expect(display.standard.priceDetail).toBe('/month');
    expect(display.standard.introDetail).toBeNull();
    expect(display.commit.primaryPrice).toBe('$306');
    expect(display.commit.priceDetail).toBe('/6-month commit');
    expect(display.commit.monthlyEquivalent).toBe('$51/month effective');
    expect(display.selfServiceInstanceType).toBe('perf-1-3');
  });

  it('formats live legacy signup prices with preserved Standard intro economics', () => {
    const display = createKiloClawSignupDisplay({
      standardCostMicrodollars: 4_000_000,
      commitCostMicrodollars: 48_000_000,
    });

    expect(display.standard.primaryPrice).toBe('$4');
    expect(display.standard.priceDetail).toBe('first month');
    expect(display.standard.introDetail).toBe('then $9/month');
    expect(display.commit.primaryPrice).toBe('$48');
    expect(display.commit.priceDetail).toBe('/6-month commit');
    expect(display.commit.monthlyEquivalent).toBe('$8/month effective');
    expect(display.selfServiceInstanceType).toBe('perf-1-3');
  });

  it('keeps canceled legacy history on current signup display when first charges are current', () => {
    const display = createKiloClawSignupDisplay({
      standardCostMicrodollars: 55_000_000,
      commitCostMicrodollars: 306_000_000,
    });

    expect(display.standard.introDetail).toBeNull();
    expect(display.standard.accessoryDetail).toBe('$55/month with no long-term commitment.');
    expect(display.commit.accessoryDetail).toBe('$306 billed upfront for a 6-month commit.');
  });

  it('formats active subscription prices from the row price version', () => {
    expect(formatKiloClawPlanPrice({ plan: 'standard', priceVersion: '2026-03-19' })).toBe(
      '$9/month'
    );
    expect(formatKiloClawPlanPrice({ plan: 'commit', priceVersion: '2026-03-19' })).toBe(
      '$48/6-month commit'
    );
    expect(formatKiloClawPlanPrice({ plan: 'standard', priceVersion: '2026-05-10' })).toBe(
      '$55/month'
    );
    expect(formatKiloClawPlanPrice({ plan: 'commit', priceVersion: '2026-05-10' })).toBe(
      '$306/6-month commit'
    );
  });
});

describe('KiloClaw funding and recovery copy', () => {
  it.each([
    ['credits_not_settled', true, null, null],
    ['enrollment_failed', true, '/claw/subscription', 'Choose hosting plan'],
    ['requires_reprovision', false, null, null],
    ['missing_instance', false, null, null],
    ['destroyed_instance', false, null, null],
    ['stale_intent', false, '/claw/subscription', 'Choose hosting plan'],
    ['invalid_intent', false, '/claw/subscription', 'Choose hosting plan'],
    ['insufficient_credits', false, '/claw/subscription', 'Review hosting options'],
    ['expired_commit', false, '/claw/subscription', 'Choose Standard hosting'],
    ['unexpected_error', false, null, null],
  ] as const)(
    'maps %s to the correct recovery policy',
    (reason, canRetry, destination, destinationLabel) => {
      expect(getKiloPassHostingRecoveryCopy(reason)).toEqual(
        expect.objectContaining({ canRetry, destination, destinationLabel })
      );
    }
  );

  it('distinguishes credit-funded hosting from a separate recurring Stripe subscription', () => {
    expect(
      getKiloClawFundingChoiceCopy({ plan: 'standard', costMicrodollars: 55_000_000 })
    ).toEqual({
      creditHeading: 'Credit-funded hosting',
      creditDescription:
        'Standard first charge: $55/month. Future hosting charges use your credit balance.',
      creditButtonLabel: 'Activate Standard with credits',
      stripeDividerLabel: 'or start a separate Stripe subscription',
      stripeButtonLabel: 'Subscribe with Stripe, $55/month',
      stripeDescription: 'Creates a separate recurring Stripe charge for hosting.',
    });
  });
});

describe('KiloClaw retirement display helpers', () => {
  it('preserves explicit server retirement display fields', () => {
    expect(
      getKiloClawRetirementDisplay({
        plan: 'commit',
        paymentSource: 'credits',
        hasStripeFunding: false,
        commitEndsAt: '2026-12-06T00:00:00.000Z',
        isFinalCommitTerm: true,
        commitRetirementState: 'standard_scheduled',
        finalCommitEndsAt: '2027-01-06T00:00:00.000Z',
        standardContinuationPriceMicrodollars: 9_000_000,
        currentFundingSource: 'stripe',
        futureFundingSource: 'credits',
        standardContinuationScheduled: true,
        needsSupportReview: false,
      })
    ).toEqual({
      isFinalCommitTerm: true,
      commitRetirementState: 'standard_scheduled',
      finalCommitEndsAt: '2027-01-06T00:00:00.000Z',
      standardContinuationPriceMicrodollars: 9_000_000,
      currentFundingSource: 'stripe',
      futureFundingSource: 'credits',
      standardContinuationScheduled: true,
      needsSupportReview: false,
    });
  });

  it('gracefully derives funding and review state when optional display fields are absent', () => {
    expect(
      getKiloClawRetirementDisplay({
        plan: 'commit',
        paymentSource: 'credits',
        hasStripeFunding: true,
        commitEndsAt: '2026-12-06T00:00:00.000Z',
        commitRetirementState: 'manual_review',
      })
    ).toEqual({
      isFinalCommitTerm: false,
      commitRetirementState: 'manual_review',
      finalCommitEndsAt: null,
      standardContinuationPriceMicrodollars: null,
      currentFundingSource: 'stripe',
      futureFundingSource: 'stripe',
      standardContinuationScheduled: false,
      needsSupportReview: true,
    });
  });
});

describe('BillingBanner credit renewal recovery', () => {
  it('routes pure-credit past-due subscriptions to credit top-up', () => {
    const html = renderToStaticMarkup(
      React.createElement(BillingBanner, {
        billing: createBillingStatus({
          subscription: {
            status: 'past_due',
            hasStripeFunding: false,
            paymentSource: 'credits',
          },
        }),
        onSubscribeClick: () => undefined,
        onReactivateClick: () => undefined,
        onUpdatePaymentClick: () => undefined,
      })
    );

    expect(html).toContain('Your credit balance is insufficient for the next renewal.');
    expect(html).toContain('Add Credits');
    expect(html).toContain('href="/credits"');
    expect(html).not.toContain('Update Payment');
  });

  it('keeps Stripe-funded hybrid past-due subscriptions on payment recovery', () => {
    const html = renderToStaticMarkup(
      React.createElement(BillingBanner, {
        billing: createBillingStatus({
          subscription: {
            status: 'past_due',
            hasStripeFunding: true,
            paymentSource: 'credits',
          },
        }),
        onSubscribeClick: () => undefined,
        onReactivateClick: () => undefined,
        onUpdatePaymentClick: () => undefined,
      })
    );

    expect(html).toContain('Your subscription payment failed.');
    expect(html).toContain('Update Payment');
    expect(html).not.toContain('href="/credits"');
    expect(html).not.toContain('Add Credits');
  });
});

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
