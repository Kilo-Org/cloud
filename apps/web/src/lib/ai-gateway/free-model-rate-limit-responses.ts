import { NextResponse } from 'next/server';
import { PROMOTION_MAX_REQUESTS, PROMOTION_WINDOW_HOURS } from '@/lib/constants';
import { ProxyErrorType } from '@/lib/proxy-error-types';

export function freeModelFeatureAuthenticationRequiredResponse(): NextResponse<unknown> {
  return NextResponse.json(
    {
      error: 'Authentication required for this feature',
      error_type: ProxyErrorType.authentication_required,
    },
    { status: 401 }
  );
}

export function freeModelRateLimitExceededResponse(
  subject: string,
  model: string,
  requestCount: number
): NextResponse<unknown> {
  console.warn(
    `Free model rate limit exceeded, ${subject}, model: ${model}, request count: ${requestCount}`
  );
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      error_type: ProxyErrorType.rate_limit_exceeded,
      message: 'Free model usage limit reached. Please try again later or upgrade to a paid model.',
    },
    { status: 429 }
  );
}

export function promotionLimitExceededResponse(
  ipAddress: string,
  model: string,
  requestCount: number
): NextResponse<unknown> {
  console.warn(
    `Promotion model limit exceeded, ip: ${ipAddress}, ` +
      `model: ${model}, ` +
      `requests: ${requestCount}/${PROMOTION_MAX_REQUESTS} ` +
      `in ${PROMOTION_WINDOW_HOURS}h window`
  );

  return NextResponse.json(
    {
      error: {
        code: 'PROMOTION_MODEL_LIMIT_REACHED',
        message:
          'Sign up for free to continue and explore 500 other models. ' +
          'Takes 2 minutes, no credit card required. Or come back later.',
      },
      error_type: ProxyErrorType.promotion_limit_reached,
    },
    { status: 401 } // TODO: Change to 429 once the extension supports it (see kilocode errorUtils.ts)
  );
}
