import 'server-only';

import { IMPACT_REFERRAL_TOUCH_VALIDITY_MS } from '@/lib/impact/referral-utils';
import { type ImpactAttributionTouch } from '@kilocode/db/schema';
import { ImpactAttributionTouchType, type ImpactReferralProduct } from '@kilocode/db/schema-types';

/**
 * Conversion-time attribution shared by every Impact referral product.
 *
 * Referral-priority attribution: a valid referral touch beats a valid affiliate
 * touch unless that affiliate touch was already sale-attributed before the
 * referral touch happened, which preserves affiliate credit for the initial
 * sale and its renewals.
 */
export type WinningAttributionResolution =
  | {
      winner: 'referral';
      referralTouch: ImpactAttributionTouch;
      affiliateTouch: ImpactAttributionTouch | null;
    }
  | {
      winner: 'affiliate';
      affiliateTouch: ImpactAttributionTouch;
      referralTouch: ImpactAttributionTouch | null;
    }
  | {
      winner: 'none';
      affiliateTouch: ImpactAttributionTouch | null;
      referralTouch: ImpactAttributionTouch | null;
    };

function hasAcceptedTrackingValue(touch: ImpactAttributionTouch): boolean {
  return touch.is_tracking_value_accepted && Boolean(touch.opaque_tracking_value?.trim());
}

function isTouchValidAtConversion(touch: ImpactAttributionTouch, convertedAt: Date): boolean {
  const touchedAt = new Date(touch.touched_at).getTime();
  const convertedAtMs = convertedAt.getTime();
  // Qualification intentionally ignores the denormalized expires_at column: the referral
  // spec defines validity as touched_at + 30 * 24h using server UTC timestamps.
  const exactExpiration = touchedAt + IMPACT_REFERRAL_TOUCH_VALIDITY_MS;
  return (
    hasAcceptedTrackingValue(touch) && touchedAt <= convertedAtMs && convertedAtMs < exactExpiration
  );
}

export function resolveWinningAttributionTouch(params: {
  product?: ImpactReferralProduct | null;
  touches: ImpactAttributionTouch[];
  convertedAt: Date;
}): WinningAttributionResolution {
  const scopedTouches = params.product
    ? params.touches.filter(touch => touch.product === params.product)
    : params.touches;
  const validReferralTouches = scopedTouches
    .filter(
      touch =>
        touch.touch_type === ImpactAttributionTouchType.Referral &&
        isTouchValidAtConversion(touch, params.convertedAt)
    )
    .sort((a, b) => new Date(a.touched_at).getTime() - new Date(b.touched_at).getTime());
  const validAffiliateTouches = scopedTouches
    .filter(
      touch =>
        touch.touch_type === ImpactAttributionTouchType.Affiliate &&
        isTouchValidAtConversion(touch, params.convertedAt)
    )
    .sort((a, b) => new Date(a.touched_at).getTime() - new Date(b.touched_at).getTime());

  const oldestReferralTouch = validReferralTouches[0] ?? null;
  const oldestAffiliateTouch = validAffiliateTouches[0] ?? null;

  if (!oldestReferralTouch && !oldestAffiliateTouch) {
    return {
      winner: 'none',
      affiliateTouch: null,
      referralTouch: null,
    };
  }

  if (!oldestReferralTouch && oldestAffiliateTouch) {
    return {
      winner: 'affiliate',
      affiliateTouch: oldestAffiliateTouch,
      referralTouch: null,
    };
  }

  if (!oldestAffiliateTouch && oldestReferralTouch) {
    return {
      winner: 'referral',
      affiliateTouch: null,
      referralTouch: oldestReferralTouch,
    };
  }

  const preservedAffiliateTouch = validAffiliateTouches.find(touch => {
    if (!touch.sale_attributed_at) return false;
    return (
      new Date(touch.sale_attributed_at).getTime() <
      new Date(oldestReferralTouch.touched_at).getTime()
    );
  });

  if (preservedAffiliateTouch) {
    return {
      winner: 'affiliate',
      affiliateTouch: preservedAffiliateTouch,
      referralTouch: oldestReferralTouch,
    };
  }

  return {
    winner: 'referral',
    affiliateTouch: oldestAffiliateTouch,
    referralTouch: oldestReferralTouch,
  };
}
