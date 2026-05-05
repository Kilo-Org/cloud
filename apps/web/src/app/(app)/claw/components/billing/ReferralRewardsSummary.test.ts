import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import { ReferralRewardsSummary } from './ReferralRewardsSummary';
import type { ClawBillingStatus } from './billing-types';

const emptyRewards: NonNullable<ClawBillingStatus['subscription']>['referralRewards'] = {
  totalAppliedMonths: 0,
  applications: [],
};

describe('ReferralRewardsSummary', () => {
  it('renders the empty state with a primary refer-a-friend CTA', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferralRewardsSummary, { rewards: emptyRewards })
    );

    expect(html).toContain('Referral rewards');
    expect(html).toContain('No rewards yet. Refer a friend to earn a free month.');
    expect(html).toContain('Refer a friend');
    expect(html).toContain('href="/claw/refer"');
  });

  it('renders applied reward rows with renewal boundaries and Kilo-voice role label', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferralRewardsSummary, {
        rewards: {
          totalAppliedMonths: 1,
          applications: [
            {
              role: 'referrer',
              appliedAt: '2026-04-10T00:05:00.000Z',
              monthsGranted: 1,
              previousRenewalBoundary: '2026-05-01T00:00:00.000Z',
              newRenewalBoundary: '2026-06-01T00:00:00.000Z',
            },
          ],
        },
      })
    );

    expect(html).toContain('1 free month applied');
    expect(html).toContain('Reward for referring');
    expect(html).toContain('Applied April 10, 2026');
    expect(html).toContain('May 1, 2026');
    expect(html).toContain('June 1, 2026');
  });

  it('uses the welcome-reward label for referee rewards', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferralRewardsSummary, {
        rewards: {
          totalAppliedMonths: 1,
          applications: [
            {
              role: 'referee',
              appliedAt: '2026-04-10T00:05:00.000Z',
              monthsGranted: 1,
              previousRenewalBoundary: '2026-05-01T00:00:00.000Z',
              newRenewalBoundary: '2026-06-01T00:00:00.000Z',
            },
          ],
        },
      })
    );

    expect(html).toContain('Welcome reward');
  });

  it('drops its own border when rendered as a section variant', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferralRewardsSummary, {
        rewards: emptyRewards,
        variant: 'section',
      })
    );

    // The card variant has bg-background/40; the section variant must not.
    expect(html).not.toContain('bg-background/40');
    expect(html).toContain('border-t');
  });
});
