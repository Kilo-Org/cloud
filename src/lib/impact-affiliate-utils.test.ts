import { describe, expect, it } from '@jest/globals';

import {
  IMPACT_SIGNUP_FALLBACK_MAX_ACCOUNT_AGE_MS,
  shouldTrackImpactReSubscription,
  shouldTrackImpactSignupFallback,
} from '@/lib/impact-affiliate-utils';

describe('impact affiliate utils', () => {
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

  describe('shouldTrackImpactReSubscription', () => {
    it('treats settled hybrid subscription cycles as re-subscriptions', () => {
      expect(
        shouldTrackImpactReSubscription({
          billingReason: 'subscription_cycle',
          subscriptionRow: {
            paymentSource: 'credits',
            stripeSubscriptionId: 'sub_123',
          },
        })
      ).toBe(true);
    });

    it('treats first delayed-billing invoices as sales before hybrid conversion', () => {
      expect(
        shouldTrackImpactReSubscription({
          billingReason: 'subscription_cycle',
          subscriptionRow: {
            paymentSource: 'stripe',
            stripeSubscriptionId: 'sub_123',
          },
        })
      ).toBe(false);
    });
  });
});
