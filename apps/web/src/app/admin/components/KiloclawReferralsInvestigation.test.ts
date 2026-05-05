import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import { KiloclawReferralsInvestigationResults } from './KiloclawReferralsInvestigation';

const result = {
  referrer: { id: 'referrer-1', email: 'referrer@example.com', name: 'Referrer' },
  referrals: [
    {
      referral: {
        id: '11111111-1111-4111-8111-111111111111',
        impactReferralId: 'RS-SUPPORT',
        createdAt: '2026-04-01T00:00:00.000Z',
      },
      referee: { id: 'referee-1', email: 'qualified@example.com', name: null },
      sourceTouch: null,
      conversion: {
        id: '22222222-2222-4222-8222-222222222222',
        winningTouchType: 'referral',
        sourcePaymentId: 'qualified-payment',
        qualified: true,
        disqualificationReason: null,
        convertedAt: '2026-04-10T00:00:00.000Z',
      },
      rewardDecisions: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          beneficiaryUserId: 'referrer-1',
          beneficiaryRole: 'referrer',
          outcome: 'granted',
          reason: null,
          monthsGranted: 1,
          createdAt: '2026-04-10T00:00:00.000Z',
        },
      ],
      rewards: [],
      rewardApplications: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          beneficiaryUserId: 'referrer-1',
          subscriptionId: '55555555-5555-4555-8555-555555555555',
          previousRenewalBoundary: '2026-05-01T00:00:00.000Z',
          newRenewalBoundary: '2026-06-01T00:00:00.000Z',
          appliedAt: '2026-04-10T00:05:00.000Z',
        },
      ],
      impactReports: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          state: 'delivered',
          actionTrackerId: 71659,
          orderId: 'qualified-payment',
          deliveredAt: '2026-04-10T00:06:00.000Z',
          nextRetryAt: null,
          responseStatusCode: null,
        },
      ],
    },
    {
      referral: {
        id: '77777777-7777-4777-8777-777777777777',
        impactReferralId: 'RS-SUPPORT',
        createdAt: '2026-04-02T00:00:00.000Z',
      },
      referee: { id: 'referee-2', email: 'disqualified@example.com', name: null },
      sourceTouch: null,
      conversion: {
        id: '88888888-8888-4888-8888-888888888888',
        winningTouchType: 'referral',
        sourcePaymentId: 'disqualified-payment',
        qualified: false,
        disqualificationReason: 'referral_self_referral',
        convertedAt: '2026-04-10T00:00:00.000Z',
      },
      rewardDecisions: [
        {
          id: '99999999-9999-4999-8999-999999999999',
          beneficiaryUserId: 'referrer-1',
          beneficiaryRole: 'referrer',
          outcome: 'disqualified',
          reason: 'referral_self_referral',
          monthsGranted: 0,
          createdAt: '2026-04-10T00:00:00.000Z',
        },
      ],
      rewards: [],
      rewardApplications: [],
      impactReports: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          state: 'failed',
          actionTrackerId: 71659,
          orderId: 'disqualified-payment',
          deliveredAt: null,
          nextRetryAt: null,
          responseStatusCode: 400,
        },
      ],
    },
  ],
};

describe('KiloclawReferralsInvestigationResults', () => {
  it('renders qualified and disqualified referee diagnostics', () => {
    const html = renderToStaticMarkup(
      React.createElement(KiloclawReferralsInvestigationResults, { result })
    );

    expect(html).toContain('referrer@example.com');
    expect(html).toContain('qualified@example.com');
    expect(html).toContain('disqualified@example.com');
    expect(html).toContain('Qualified');
    expect(html).toContain('Disqualified');
    expect(html).toContain('referral_self_referral');
    expect(html).toContain('granted');
    expect(html).toContain('disqualified');
    expect(html).toContain('delivered');
    expect(html).toContain('failed');
    expect(html).toContain('May 1, 2026 to');
    expect(html).toContain('June 1, 2026');
  });
});
