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
}) {
  return {
    referral: {
      id: params.referralId,
      impactReferralId: 'RS-SUPPORT',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    referee: { id: `${params.referralId}-referee`, email: params.refereeEmail, name: null },
    sourceTouch: null,
    conversion: {
      id: `${params.referralId}-conversion`,
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
        outcome: params.qualified ? 'granted' : 'disqualified',
        reason: params.disqualificationReason,
        monthsGranted: params.qualified ? 1 : 0,
        createdAt: '2026-04-10T00:00:00.000Z',
      },
    ],
    rewards: [],
    rewardApplications: params.qualified
      ? [
          {
            id: `${params.referralId}-application`,
            beneficiaryUserId: 'referrer-1',
            subscriptionId: '55555555-5555-4555-8555-555555555555',
            previousRenewalBoundary: '2026-05-01T12:00:00.000Z',
            newRenewalBoundary: '2026-06-01T12:00:00.000Z',
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
  };
}

const result = {
  referrer: { id: 'referrer-1', email: 'referrer@example.com', name: 'Referrer' },
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
    expect(html).toContain('Qualified');
    expect(html).toContain('Disqualified');
    expect(html).toContain('referral_self_referral');
    expect(html).toContain('granted');
    expect(html).toContain('delivered, tracker 71659, order qualified-payment');
    expect(html).toContain('failed, tracker 71659, order disqualified-payment, HTTP 400');
    expect(html).toContain('May 1, 2026 to');
    expect(html).toContain('June 1, 2026');
  });
});
