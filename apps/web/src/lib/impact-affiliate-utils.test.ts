import { describe, expect, it } from '@jest/globals';

import {
  IMPACT_CLICK_ID_COOKIE,
  IMPACT_SIGNUP_FALLBACK_MAX_ACCOUNT_AGE_MS,
  IMPACT_TRACKED_CLICK_ID_COOKIE,
  shouldTrackImpactSignupFallback,
} from '@/lib/impact-affiliate-utils';

describe('impact affiliate utils', () => {
  describe('cookie contract', () => {
    it('uses the shared kilo.ai parent-domain cookie names for auth recovery', () => {
      expect(IMPACT_CLICK_ID_COOKIE).toBe('impact_click_id');
      expect(IMPACT_TRACKED_CLICK_ID_COOKIE).toBe('impact_tracked_click_id');
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
