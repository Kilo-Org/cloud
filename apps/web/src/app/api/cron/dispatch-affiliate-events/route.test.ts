import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/impact/affiliate-events', () => ({
  dispatchQueuedAffiliateEvents: jest.fn(),
}));

jest.mock('@/lib/impact/referral', () => ({
  dispatchQueuedImpactAdvocateRegistrationAttempts: jest.fn(),
}));

jest.mock('@/lib/impact/kiloclaw-referrals', () => ({
  dispatchQueuedImpactAdvocateRewardRedemptions: jest.fn(),
  dispatchQueuedImpactConversionReports: jest.fn(),
  processQueuedKiloClawReferralRewards: jest.fn(),
}));

import { dispatchQueuedAffiliateEvents } from '@/lib/impact/affiliate-events';
import { dispatchQueuedImpactAdvocateRegistrationAttempts } from '@/lib/impact/referral';
import {
  dispatchQueuedImpactAdvocateRewardRedemptions,
  dispatchQueuedImpactConversionReports,
  processQueuedKiloClawReferralRewards,
} from '@/lib/impact/kiloclaw-referrals';
import { GET } from './route';

const mockDispatchQueuedAffiliateEvents = jest.mocked(dispatchQueuedAffiliateEvents);
const mockDispatchQueuedImpactAdvocateRegistrationAttempts = jest.mocked(
  dispatchQueuedImpactAdvocateRegistrationAttempts
);
const mockDispatchQueuedImpactConversionReports = jest.mocked(
  dispatchQueuedImpactConversionReports
);
const mockDispatchQueuedImpactAdvocateRewardRedemptions = jest.mocked(
  dispatchQueuedImpactAdvocateRewardRedemptions
);
const mockProcessQueuedKiloClawReferralRewards = jest.mocked(processQueuedKiloClawReferralRewards);

describe('GET /api/cron/dispatch-affiliate-events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthorized requests', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-affiliate-events', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockDispatchQueuedAffiliateEvents).not.toHaveBeenCalled();
    expect(mockDispatchQueuedImpactAdvocateRegistrationAttempts).not.toHaveBeenCalled();
    expect(mockDispatchQueuedImpactConversionReports).not.toHaveBeenCalled();
    expect(mockProcessQueuedKiloClawReferralRewards).not.toHaveBeenCalled();
    expect(mockDispatchQueuedImpactAdvocateRewardRedemptions).not.toHaveBeenCalled();
  });

  it('dispatches queued affiliate events when authorized', async () => {
    mockDispatchQueuedAffiliateEvents.mockResolvedValue({
      reclaimed: 1,
      claimed: 3,
      delivered: 2,
      retried: 1,
      failed: 0,
      unblocked: 1,
    });
    mockDispatchQueuedImpactAdvocateRegistrationAttempts.mockResolvedValue({
      claimed: 2,
      delivered: 1,
      retried: 1,
      failed: 0,
    });
    mockDispatchQueuedImpactConversionReports.mockResolvedValue({
      claimed: 2,
      delivered: 1,
      retried: 1,
      failed: 0,
    });
    mockProcessQueuedKiloClawReferralRewards.mockResolvedValue({
      claimed: 3,
      applied: 2,
      expired: 1,
      pending: 0,
      failed: 0,
    });
    mockDispatchQueuedImpactAdvocateRewardRedemptions.mockResolvedValue({
      claimed: 2,
      redeemed: 2,
      retried: 0,
      failed: 0,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-affiliate-events', {
        method: 'GET',
        headers: {
          authorization: 'Bearer cron-secret',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockDispatchQueuedAffiliateEvents).toHaveBeenCalledTimes(1);
    expect(mockDispatchQueuedImpactAdvocateRegistrationAttempts).toHaveBeenCalledTimes(1);
    expect(mockDispatchQueuedImpactConversionReports).toHaveBeenCalledTimes(1);
    expect(mockProcessQueuedKiloClawReferralRewards).toHaveBeenCalledTimes(1);
    expect(mockDispatchQueuedImpactAdvocateRewardRedemptions).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        summary: {
          affiliateEvents: {
            reclaimed: 1,
            claimed: 3,
            delivered: 2,
            retried: 1,
            failed: 0,
            unblocked: 1,
          },
          impactAdvocateRegistrations: {
            claimed: 2,
            delivered: 1,
            retried: 1,
            failed: 0,
          },
          impactConversionReports: {
            claimed: 2,
            delivered: 1,
            retried: 1,
            failed: 0,
          },
          referralRewards: {
            claimed: 3,
            applied: 2,
            expired: 1,
            pending: 0,
            failed: 0,
          },
          impactAdvocateRewardRedemptions: {
            claimed: 2,
            redeemed: 2,
            retried: 0,
            failed: 0,
          },
        },
        timestamp: expect.any(String),
      })
    );
  });
});
