import { NextRequest } from 'next/server';

jest.mock('@/lib/constants', () => ({
  APP_URL: 'http://localhost:3000',
}));

jest.mock('@/lib/user/server', () => ({
  getProfileRedirectPath: jest.fn(async () => '/users/profile'),
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/affiliate-attribution', () => ({
  getAffiliateAttribution: jest.fn(),
}));

jest.mock('@/lib/impact/affiliate-events', () => ({
  recordAffiliateAttributionAndQueueParentEvent: jest.fn(),
}));

jest.mock('@/lib/impact/referral', () => ({
  countryCodeFromHeaders: jest.fn(() => null),
  localeFromHeaders: jest.fn(() => null),
  queueImpactAdvocateParticipantRegistration: jest.fn(),
  recordImpactAffiliateTouch: jest.fn(),
  recordImpactReferralTouch: jest.fn(),
}));

jest.mock('@/lib/impact/debug', () => ({
  logImpactReferralDebug: jest.fn(),
}));

jest.mock('@/lib/posthog', () => jest.fn(() => ({ capture: jest.fn() })));

jest.mock('@/lib/survey-redirect', () => ({
  maybeInterceptWithSurvey: jest.fn((_, responsePath: string) => responsePath),
}));

jest.mock('@/lib/credit-campaigns', () => ({
  isCreditCampaignCallback: jest.fn(() => null),
  lookupCampaignBySlug: jest.fn(),
}));

import { getAffiliateAttribution } from '@/lib/affiliate-attribution';
import { recordAffiliateAttributionAndQueueParentEvent } from '@/lib/impact/affiliate-events';
import { getUserFromAuth } from '@/lib/user/server';
import { GET } from './route';

const mockGetAffiliateAttribution = jest.mocked(getAffiliateAttribution);
const mockRecordAffiliateAttributionAndQueueParentEvent = jest.mocked(
  recordAffiliateAttributionAndQueueParentEvent
);
const mockGetUserFromAuth = jest.mocked(getUserFromAuth);

describe('GET /users/after-sign-in', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-after-sign-in',
        google_user_email: 'after-sign-in@example.com',
        blocked_reason: null,
        has_validation_stytch: true,
      },
    } as Awaited<ReturnType<typeof getUserFromAuth>>);
  });

  it('continues redirect flow when affiliate attribution lookup fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetAffiliateAttribution.mockRejectedValueOnce(new Error('affiliate lookup unavailable'));

    const response = await GET(
      new NextRequest('http://localhost:3000/users/after-sign-in?im_ref=impact-click-123')
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/users/profile');
    expect(mockRecordAffiliateAttributionAndQueueParentEvent).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[after-sign-in] failed to persist affiliate attribution',
      expect.objectContaining({
        userId: 'user-after-sign-in',
        error: 'affiliate lookup unavailable',
      })
    );
    consoleError.mockRestore();
  });
});
