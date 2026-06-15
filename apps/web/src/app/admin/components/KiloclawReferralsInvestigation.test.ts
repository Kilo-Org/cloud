import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import { KiloclawReferralsInvestigationResults } from './KiloclawReferralsInvestigation';

function referralRow(params: {
  referralId: string;
  refereeEmail: string;
  paymentId: string;
  qualified: boolean;
  disqualificationReason: string | null;
  impactReportState: string;
  product?: 'kiloclaw' | 'kilo_pass';
  rewardStatus?: string;
}) {
  const product = params.product ?? 'kiloclaw';
  const productLabel = product === 'kilo_pass' ? 'Kilo Pass' : 'KiloClaw';

  return {
    referral: {
      id: params.referralId,
      product,
      productLabel,
      impactReferralId: 'RS-SUPPORT',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    referee: { id: `${params.referralId}-referee`, email: params.refereeEmail, name: null },
    sourceTouch: null,
    conversion: {
      id: `${params.referralId}-conversion`,
      product,
      paymentProvider: product === 'kilo_pass' ? 'stripe' : 'credits',
      winningTouchType: 'referral',
      sourcePaymentId: params.paymentId,
      qualified: params.qualified,
      disqualificationReason: params.disqualificationReason,
      convertedAt: '2026-04-10T00:00:00.000Z',
    },
    rewardDecisions: [
      {
        id: `${params.referralId}-decision`,
        beneficiaryUserId: 'referrer-1',
        beneficiaryRole: 'referrer',
        product,
        outcome: params.qualified ? 'granted' : 'disqualified',
        reason: params.disqualificationReason,
        rewardKind: product === 'kilo_pass' ? 'kilo_pass_bonus' : 'kiloclaw_free_month',
        monthsGranted: product === 'kiloclaw' && params.qualified ? 1 : 0,
        rewardPercent: product === 'kilo_pass' ? 0.5 : null,
        sourceTier: product === 'kilo_pass' ? 'tier_49' : null,
        rewardAmountUsd: product === 'kilo_pass' && params.qualified ? 24.5 : null,
        createdAt: '2026-04-10T00:00:00.000Z',
      },
    ],
    rewards: params.qualified
      ? [
          {
            id: `${params.referralId}-reward`,
            product,
            beneficiaryUserId: 'referrer-1',
            beneficiaryRole: 'referrer',
            rewardKind: product === 'kilo_pass' ? 'kilo_pass_bonus' : 'kiloclaw_free_month',
            status: params.rewardStatus ?? 'applied',
            monthsGranted: product === 'kiloclaw' ? 1 : 0,
            rewardPercent: product === 'kilo_pass' ? 0.5 : null,
            sourceTier: product === 'kilo_pass' ? 'tier_49' : null,
            rewardAmountUsd: product === 'kilo_pass' ? 24.5 : null,
            earnedAt: '2026-04-10T00:00:00.000Z',
            appliedAt: params.rewardStatus === 'pending' ? null : '2026-04-10T00:05:00.000Z',
            expiresAt: '2027-04-10T00:00:00.000Z',
            reviewReason:
              params.rewardStatus === 'review_required' ? 'referral_payment_chargeback' : null,
            appliesToKiloPassSubscriptionId: null,
            consumedKiloPassIssuanceId: null,
            consumedKiloPassIssuanceItemId: null,
          },
        ]
      : [],
    rewardApplications: params.qualified
      ? [
          {
            id: `${params.referralId}-application`,
            beneficiaryUserId: 'referrer-1',
            subscriptionId: '55555555-5555-4555-8555-555555555555',
            previousRenewalBoundary: '2026-05-01T12:00:00.000Z',
            product,
            newRenewalBoundary: '2026-06-01T12:00:00.000Z',
            localOperationId: null,
            stripeOperationId: null,
            appliedAt: '2026-04-10T00:05:00.000Z',
          },
        ]
      : [],
    impactReports: [
      {
        id: `${params.referralId}-report`,
        state: params.impactReportState,
        actionTrackerId: 71659,
        orderId: params.paymentId,
        deliveredAt: params.impactReportState === 'delivered' ? '2026-04-10T00:06:00.000Z' : null,
        nextRetryAt: null,
        responseStatusCode: params.impactReportState === 'failed' ? 400 : null,
      },
    ],
    impactRewardRedemptions: [],
  };
}

const result = {
  product: 'kiloclaw' as const,
  productLabel: 'KiloClaw',
  referrer: { id: 'referrer-1', email: 'referrer@example.com', name: 'Referrer' },
  participantRegistrations: [
    {
      id: '55555555-5555-4555-8555-555555555556',
      programKey: 'kiloclaw' as const,
      registrationState: 'pending',
      registeredAt: null,
      lastRegistrationAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      latestAttempt: {
        id: '55555555-5555-4555-8555-555555555557',
        deliveryState: 'queued',
        responseStatusCode: null,
        nextRetryAt: '2026-04-11T00:00:00.000Z',
        createdAt: '2026-04-10T00:00:00.000Z',
      },
    },
  ],
  referrals: [
    referralRow({
      referralId: 'qualified-referral',
      refereeEmail: 'qualified@example.com',
      paymentId: 'qualified-payment',
      qualified: true,
      disqualificationReason: null,
      impactReportState: 'delivered',
    }),
    referralRow({
      referralId: 'disqualified-referral',
      refereeEmail: 'disqualified@example.com',
      paymentId: 'disqualified-payment',
      qualified: false,
      disqualificationReason: 'referral_self_referral',
      impactReportState: 'failed',
    }),
  ],
};

describe('KiloclawReferralsInvestigationResults', () => {
  it('renders qualified and disqualified referee diagnostics with reward and Impact state', () => {
    const html = renderToStaticMarkup(
      React.createElement(KiloclawReferralsInvestigationResults, { result })
    );

    expect(html).toContain('referrer@example.com');
    expect(html).toContain('KiloClaw referrer');
    expect(html).toContain('kiloclaw: pending');
    expect(html).toContain('Latest attempt: queued');
    expect(html).toContain('Qualified');
    expect(html).toContain('Disqualified');
    expect(html).toContain('referral_self_referral');
    expect(html).toContain('granted');
    expect(html).toContain('applied, 1 month');
    expect(html).toContain('delivered, tracker 71659, order qualified-payment');
    expect(html).toContain('failed, tracker 71659, order disqualified-payment, HTTP 400');
    expect(html).toContain('May 1, 2026 to');
    expect(html).toContain('June 1, 2026');
  });
});
