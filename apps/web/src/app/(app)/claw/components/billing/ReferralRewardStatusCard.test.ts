import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import { ReferralRewardStatusCard } from './ReferralRewardStatusCard';

const emptySummary = {
  totals: {
    totalRewards: 0,
    pendingRewards: 0,
    totalAppliedMonths: 0,
  },
  pendingRewardAction: {
    showStartReactivateCta: false,
    pendingRewardCount: 0,
  },
  referredPeople: [],
  rewards: [],
};

describe('ReferralRewardStatusCard', () => {
  it('renders the empty state with a referral-share CTA and no warning state', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferralRewardStatusCard, { summary: emptySummary })
    );

    expect(html).toContain('No referral rewards yet.');
    expect(html).toContain('href="#referral-share"');
    expect(html).not.toContain('data-testid="summary-indicator-warning"');
    expect(html).not.toContain('credits');
    expect(html).not.toContain('awards');
  });

  it('renders the Impact share widget slot when provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferralRewardStatusCard, {
        summary: emptySummary,
        shareWidget: React.createElement('div', { 'data-testid': 'share-widget' }, 'widget body'),
      })
    );

    expect(html).toContain('id="referral-share"');
    expect(html).toContain('data-testid="share-widget"');
    expect(html).toContain('widget body');
  });

  it('surfaces on-hold rewards, applied renewal dates, and customer-safe referee status', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferralRewardStatusCard, {
        summary: {
          totals: {
            totalRewards: 2,
            pendingRewards: 1,
            totalAppliedMonths: 1,
          },
          pendingRewardAction: {
            showStartReactivateCta: true,
            pendingRewardCount: 1,
          },
          referredPeople: [
            {
              maskedEmail: 'q***@example.com',
              state: 'reward_granted',
              rewardGranted: true,
            },
            {
              maskedEmail: 's***@example.com',
              state: 'waiting_for_paid_conversion',
              rewardGranted: false,
            },
          ],
          rewards: [
            {
              role: 'referrer',
              status: 'applied',
              monthsGranted: 1,
              earnedAt: '2026-04-10T00:00:00.000Z',
              appliedAt: '2026-04-10T00:05:00.000Z',
              expiresAt: null,
              reviewReason: null,
              application: {
                appliedAt: '2026-04-10T00:05:00.000Z',
                subscriptionId: '11111111-1111-4111-8111-111111111111',
                previousRenewalBoundary: '2026-05-01T12:00:00.000Z',
                newRenewalBoundary: '2026-06-01T12:00:00.000Z',
              },
            },
            {
              role: 'referee',
              status: 'pending',
              monthsGranted: 1,
              earnedAt: '2026-04-11T00:00:00.000Z',
              appliedAt: null,
              expiresAt: null,
              reviewReason: null,
              application: null,
            },
          ],
        },
      })
    );

    expect(html).toContain('1 reward on hold');
    expect(html).toContain('Start or reactivate KiloClaw');
    expect(html).toContain('data-testid="summary-indicator-warning"');
    expect(html).toContain('Applied');
    expect(html).toContain('May 1, 2026');
    expect(html).toContain('June 1, 2026');
    expect(html).toContain('Waiting for an eligible KiloClaw subscription');
    expect(html).toContain('q***@example.com');
    expect(html).toContain('Reward granted');
    expect(html).toContain('s***@example.com');
    expect(html).toContain('Signed up, waiting for paid KiloClaw conversion');
  });

  it('pluralizes the reactivate banner copy when more than one reward is pending', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferralRewardStatusCard, {
        summary: {
          ...emptySummary,
          totals: { totalRewards: 2, pendingRewards: 2, totalAppliedMonths: 0 },
          pendingRewardAction: { showStartReactivateCta: true, pendingRewardCount: 2 },
        },
      })
    );

    expect(html).toContain('2 rewards on hold');
    expect(html).toContain('to apply them');
  });
});
