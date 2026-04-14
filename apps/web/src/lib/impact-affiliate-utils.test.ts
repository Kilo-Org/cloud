import { describe, expect, it } from '@jest/globals';

import {
  IMPACT_APP_TRACKED_CLICK_ID_COOKIE,
  IMPACT_CLICK_ID_COOKIE,
  IMPACT_SIGNUP_FALLBACK_MAX_ACCOUNT_AGE_MS,
  resolveImpactAffiliateTrackingId,
  shouldTrackImpactSignupFallback,
} from '@/lib/impact-affiliate-utils';

describe('impact affiliate utils', () => {
  describe('cookie contract', () => {
    it('uses the shared kilo.ai parent-domain cookie names for auth recovery', () => {
      expect(IMPACT_CLICK_ID_COOKIE).toBe('impact_click_id');
      expect(IMPACT_APP_TRACKED_CLICK_ID_COOKIE).toBe('impact_app_tracked_click_id');
    });
  });

  describe('resolveImpactAffiliateTrackingId', () => {
    it('prefers the explicit im_ref param over cookie fallback', () => {
      expect(
        resolveImpactAffiliateTrackingId({
          imRefParam: 'impact-click-from-query',
          sharedImpactCookieValue: 'impact-click-from-cookie',
          appTrackedImpactCookieValue: null,
        })
      ).toEqual({
        affiliateTrackingId: 'impact-click-from-query',
        impactCookieValue: null,
      });
    });

    it('suppresses the shared cookie when the app already tracked that exact value', () => {
      expect(
        resolveImpactAffiliateTrackingId({
          imRefParam: null,
          sharedImpactCookieValue: 'impact-click-123',
          appTrackedImpactCookieValue: 'impact-click-123',
        })
      ).toEqual({
        affiliateTrackingId: null,
        impactCookieValue: null,
      });
    });

    it('accepts a changed shared cookie value even when an older app marker exists', () => {
      expect(
        resolveImpactAffiliateTrackingId({
          imRefParam: null,
          sharedImpactCookieValue: 'impact-click-new',
          appTrackedImpactCookieValue: 'impact-click-old',
        })
      ).toEqual({
        affiliateTrackingId: 'impact-click-new',
        impactCookieValue: 'impact-click-new',
      });
    });

    it('does not care about the legacy marketing-site tracked cookie name', () => {
      expect(
        resolveImpactAffiliateTrackingId({
          imRefParam: null,
          sharedImpactCookieValue: 'impact-click-123',
          appTrackedImpactCookieValue: null,
        })
      ).toEqual({
        affiliateTrackingId: 'impact-click-123',
        impactCookieValue: 'impact-click-123',
      });
    });
  });

  describe('shouldTrackImpactSignupFallback', () => {
    it('tracks explicit new users even when auth state is otherwise incomplete', () => {
      expect(
        shouldTrackImpactSignupFallback({
          isNewUser: true,
          hasValidationStytch: true,
          userCreatedAt: '2026-04-02T12:00:00.000Z',
          now: new Date('2026-04-02T13:00:00.000Z'),
        })
      ).toBe(true);
    });

    it('tracks freshly created unverified users when isNewUser is missing', () => {
      expect(
        shouldTrackImpactSignupFallback({
          hasValidationStytch: null,
          userCreatedAt: '2026-04-02T12:00:00.000Z',
          now: new Date('2026-04-02T12:10:00.000Z'),
        })
      ).toBe(true);
    });

    it('does not track older unverified users who return through an affiliate link later', () => {
      const createdAt = new Date('2026-04-02T12:00:00.000Z');
      expect(
        shouldTrackImpactSignupFallback({
          hasValidationStytch: null,
          userCreatedAt: createdAt.toISOString(),
          now: new Date(createdAt.getTime() + IMPACT_SIGNUP_FALLBACK_MAX_ACCOUNT_AGE_MS + 1),
        })
      ).toBe(false);
    });

    it('does not track verified returning users', () => {
      expect(
        shouldTrackImpactSignupFallback({
          hasValidationStytch: false,
          userCreatedAt: '2026-04-02T12:00:00.000Z',
          now: new Date('2026-04-02T12:10:00.000Z'),
        })
      ).toBe(false);
    });
  });
});
