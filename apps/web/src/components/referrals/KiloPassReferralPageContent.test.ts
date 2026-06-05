import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import { KiloPassReferralPageContent } from './KiloPassReferralPageContent';
import type { KiloPassReferralRewardSummary } from './KiloPassReferralPageContent';

const emptySummary: KiloPassReferralRewardSummary = {
  totals: {
    totalRewards: 0,
    pendingRewards: 0,
    appliedRewards: 0,
    totalRewardAmountUsd: 0,
    pendingRewardAmountUsd: 0,
    appliedRewardAmountUsd: 0,
  },
  referrerCap: {
    grantedRewards: 0,
    limit: 5,
    reached: false,
  },
  rewards: [],
};

describe('KiloPassReferralPageContent', () => {
  it('renders Kilo Pass-specific empty copy and an accessible widget region', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        KiloPassReferralPageContent,
        { summary: emptySummary },
        React.createElement('div', { 'data-testid': 'share-widget' }, 'widget body')
      )
    );

    expect(html).toContain('Earn Kilo Pass referral bonuses');
    expect(html).toContain('50% monthly Kilo Pass bonus');
    expect(html).toContain('No Kilo Pass referral rewards yet.');
    expect(html).toContain('aria-label="Kilo Pass referral sharing"');
    expect(html).toContain('data-testid="share-widget"');
    expect(html).not.toContain('Share your Kilo Pass referral link');
    expect(html).not.toContain('Use the Kilo Pass referral widget');
    expect(html).not.toContain('KiloClaw');
    expect(html).not.toContain('free month');
  });

  it('renders loading and non-sensitive error states without color-only messaging', () => {
    const loadingHtml = renderToStaticMarkup(
      React.createElement(KiloPassReferralPageContent, {
        summary: null,
        isLoading: true,
      })
    );
    const errorHtml = renderToStaticMarkup(
      React.createElement(KiloPassReferralPageContent, {
        summary: null,
        errorMessage: 'Rewards are temporarily unavailable. Try again in a minute.',
      })
    );

    expect(loadingHtml).toContain('Loading Kilo Pass referral rewards…');
    expect(loadingHtml).toContain('<output');
    expect(errorHtml).toContain('Kilo Pass referral rewards are unavailable');
    expect(errorHtml).toContain('Try again in a minute.');
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).not.toContain('stack');
  });

  it('summarizes pending, applied, history, and cap-reached reward states', () => {
    const html = renderToStaticMarkup(
      React.createElement(KiloPassReferralPageContent, {
        summary: {
          totals: {
            totalRewards: 3,
            pendingRewards: 1,
            appliedRewards: 1,
            totalRewardAmountUsd: 58.5,
            pendingRewardAmountUsd: 24.5,
            appliedRewardAmountUsd: 9.5,
          },
          referrerCap: {
            grantedRewards: 5,
            limit: 5,
            reached: true,
          },
          rewards: [
            {
              id: 'reward-pending',
              role: 'referrer',
              status: 'pending',
              rewardAmountUsd: 24.5,
              earnedAt: '2026-05-10T00:00:00.000Z',
              appliedAt: null,
              expiresAt: '2027-05-10T00:00:00.000Z',
              sourceTier: 'tier_49',
              reviewReason: null,
            },
            {
              id: 'reward-applied',
              role: 'referee',
              status: 'applied',
              rewardAmountUsd: 9.5,
              earnedAt: '2026-05-11T00:00:00.000Z',
              appliedAt: '2026-06-01T00:00:00.000Z',
              expiresAt: null,
              sourceTier: 'tier_19',
              reviewReason: null,
            },
            {
              id: 'reward-review-required',
              role: 'referrer',
              status: 'review_required',
              rewardAmountUsd: 24.5,
              earnedAt: '2026-05-12T00:00:00.000Z',
              appliedAt: null,
              expiresAt: null,
              sourceTier: 'tier_49',
              reviewReason: 'payment_refunded',
            },
          ],
        },
      })
    );

    expect(html).toContain('$58.50');
    expect(html).toContain('$24.50');
    expect(html).toContain('$9.50');
    expect(html).toContain('Cap reached');
    expect(html).toContain('5 of 5 referrer rewards');
    expect(html).toContain('Waiting for a future eligible monthly issuance');
    expect(html).toContain('Applied');
    expect(html).toContain('Needs review');
    expect(html).toContain('May 10, 2026');
    expect(html).toContain('Jun 1, 2026');
  });
});
