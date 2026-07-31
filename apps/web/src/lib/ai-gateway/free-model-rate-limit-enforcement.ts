import type { NextResponse } from 'next/server';
import { isAnonymousContext, type AnonymousUserContext } from '@/lib/anonymous';
import { isCloudflareIP } from '@/lib/cloudflare-ip';
import { isUserRateLimitedFeature, type FeatureValue } from '@/lib/feature-detection';
import {
  checkPromotionLimit,
  consumeAnonymousFreeModelRateLimits,
  consumeFreeModelRateLimit,
  consumeFreeModelRateLimitByUser,
  type RateLimitResult,
} from '@/lib/free-model-rate-limiter';
import {
  freeModelFeatureAuthenticationRequiredResponse,
  freeModelRateLimitExceededResponse,
  promotionLimitExceededResponse,
} from './free-model-rate-limit-responses';

type RateLimitUser = { id: string } | AnonymousUserContext;

type EnforceFreeModelRateLimitsInput = {
  feature: FeatureValue | null;
  ipAddress: string;
  isRateLimitedFreeModel: boolean;
  model: string;
  user: RateLimitUser;
};

export async function enforceFreeModelRateLimits({
  feature,
  ipAddress,
  isRateLimitedFreeModel,
  model,
  user,
}: EnforceFreeModelRateLimitsInput): Promise<NextResponse<unknown> | null> {
  let freeModelRateLimit: { result: RateLimitResult; subject: string } | null = null;
  let promotionLimit: RateLimitResult | null = null;

  if (isRateLimitedFreeModel && isUserRateLimitedFeature(feature) && isCloudflareIP(ipAddress)) {
    if (isAnonymousContext(user)) {
      return freeModelFeatureAuthenticationRequiredResponse();
    }
    freeModelRateLimit = {
      result: await consumeFreeModelRateLimitByUser(user.id),
      subject: `user: ${user.id}`,
    };
  } else if (isAnonymousContext(user)) {
    if (isRateLimitedFreeModel) {
      const anonymousLimits = await consumeAnonymousFreeModelRateLimits(ipAddress);
      freeModelRateLimit = {
        result: anonymousLimits.freeModel,
        subject: `ip address: ${ipAddress}`,
      };
      promotionLimit = anonymousLimits.promotion;
    } else {
      promotionLimit = await checkPromotionLimit(ipAddress);
    }
  } else if (isRateLimitedFreeModel) {
    freeModelRateLimit = {
      result: await consumeFreeModelRateLimit(ipAddress),
      subject: `ip address: ${ipAddress}`,
    };
  }

  if (freeModelRateLimit && !freeModelRateLimit.result.allowed) {
    return freeModelRateLimitExceededResponse(
      freeModelRateLimit.subject,
      model,
      freeModelRateLimit.result.requestCount
    );
  }

  if (promotionLimit && !promotionLimit.allowed) {
    return promotionLimitExceededResponse(ipAddress, model, promotionLimit.requestCount);
  }

  return null;
}
