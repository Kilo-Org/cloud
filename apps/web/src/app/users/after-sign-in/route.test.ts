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
import {
  queueImpactAdvocateParticipantRegistration,
  recordImpactAffiliateTouch,
  recordImpactReferralTouch,
} from '@/lib/impact/referral';
import { getUserFromAuth } from '@/lib/user/server';
import { GET } from './route';

const mockGetAffiliateAttribution = jest.mocked(getAffiliateAttribution);
const mockRecordAffiliateAttributionAndQueueParentEvent = jest.mocked(
  recordAffiliateAttributionAndQueueParentEvent
);
const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockQueueImpactAdvocateParticipantRegistration = jest.mocked(
  queueImpactAdvocateParticipantRegistration
);
const mockRecordImpactAffiliateTouch = jest.mocked(recordImpactAffiliateTouch);
const mockRecordImpactReferralTouch = jest.mocked(recordImpactReferralTouch);

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

  it('records and queues Kilo Pass referral touches from Kilo Pass referral-page callback paths', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost:3000/users/after-sign-in?callbackPath=%2Fsubscriptions%2Fkilo-pass%2Frefer&_saasquatch=pass-cookie&rsCode=PASSCODE'
      )
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/subscriptions/kilo-pass/refer'
    );
    expect(mockRecordImpactReferralTouch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-after-sign-in',
        touch: expect.objectContaining({
          product: 'kilo_pass',
          programKey: 'kilo_pass',
          opaqueTrackingValue: 'pass-cookie',
        }),
      })
    );
    expect(mockQueueImpactAdvocateParticipantRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: 'user-after-sign-in' }),
        referralTouch: expect.objectContaining({
          product: 'kilo_pass',
          programKey: 'kilo_pass',
          opaqueTrackingValue: 'pass-cookie',
        }),
      })
    );
  });

  it('records Kilo Pass affiliate touches from Kilo Pass callback paths', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost:3000/users/after-sign-in?callbackPath=%2Fsubscriptions%2Fkilo-pass&im_ref=impact-click'
      )
    );

    expect(response.status).toBe(307);
    expect(mockRecordImpactAffiliateTouch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-after-sign-in',
        product: 'kilo_pass',
        touch: expect.objectContaining({
          product: 'kilo_pass',
          trackingId: 'impact-click',
        }),
      })
    );
  });

  it('preserves Impact tracking parameters through unauthenticated OAuth redirects', async () => {
    mockGetUserFromAuth.mockResolvedValueOnce({ user: null } as Awaited<
      ReturnType<typeof getUserFromAuth>
    >);

    const response = await GET(
      new NextRequest(
        'http://localhost:3000/users/after-sign-in?callbackPath=%2Fsubscriptions%2Fkilo-pass%2Frefer&signup=true&_saasquatch=pass-cookie&rsCode=PASSCODE&im_ref=impact-click&utm_campaign=launch'
      )
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/users/sign_in');
    expect(location.searchParams.get('callbackPath')).toBe('/subscriptions/kilo-pass/refer');
    expect(location.searchParams.get('signup')).toBe('true');
    expect(location.searchParams.get('_saasquatch')).toBe('pass-cookie');
    expect(location.searchParams.get('rsCode')).toBe('PASSCODE');
    expect(location.searchParams.get('im_ref')).toBe('impact-click');
    expect(location.searchParams.get('utm_campaign')).toBe('launch');
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
