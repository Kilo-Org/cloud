import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createKiloClawSignupDisplay,
  deriveBannerState,
  deriveLockReason,
  formatKiloClawPlanPrice,
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
