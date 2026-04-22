import { getProfileRedirectPath, getUserFromAuth } from '@/lib/user.server';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { maybeInterceptWithSurvey } from '@/lib/survey-redirect';
import PostHogClient from '@/lib/posthog';
import { getAffiliateAttribution } from '@/lib/affiliate-attribution';
import { recordAffiliateAttributionAndQueueParentEvent } from '@/lib/affiliate-events';
import {
  IMPACT_APP_TRACKED_CLICK_ID_COOKIE,
  IMPACT_CLICK_ID_COOKIE,
  resolveImpactAffiliateTrackingId,
} from '@/lib/impact-affiliate-utils';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { APP_URL } from '@/lib/constants';
import { isOpenclawAdvisorCallback } from '@/lib/signup-source';
import { isCreditCampaignCallback, lookupCampaignBySlug } from '@/lib/credit-campaigns';

/**
 * Resolves a product identifier from the signup entry point. Returns null when
 * the entry point is generic (e.g. /get-started, /profile) so we leave the
 * property unset rather than guessing.
 */
async function resolveSignupProduct(
  callbackPath: string | null,
  hasSource: boolean
): Promise<string | null> {
  if (hasSource) return 'kilo-code'; // IDE install flow
  if (!callbackPath) return null;
  if (callbackPath.startsWith('/claw')) return 'kiloclaw';
  if (callbackPath.startsWith('/cloud')) return 'cloud-agent';
  if (callbackPath.startsWith('/code-reviews')) return 'code-reviews';
  if (callbackPath.startsWith('/app-builder')) return 'app-builder';
  if (callbackPath.startsWith('/install')) return 'kilo-code';
  // Exact-pathname match via shared helper — a naive startsWith check would
  // also attribute `/openclaw-advisor-fake` and any sibling path sharing the
  // prefix. The account-verification bonus path already uses this helper for
  // the same reason; keeping both sides on the shared check prevents the two
  // attribution paths from drifting.
  if (isOpenclawAdvisorCallback(callbackPath)) return 'openclaw-security-advisor';
  // Admin-managed URL campaigns (/c/<slug>). Bucketed under a single product
  // key so PostHog doesn't fragment analytics across every slug;
  // per-campaign breakdown is available via credit_transactions.credit_category.
  // DB-verify the slug exists so a manually crafted /c/<garbage> callback
  // doesn't leak a phantom `credit-campaign` attribution event.
  const campaignMatch = isCreditCampaignCallback(callbackPath);
  if (campaignMatch) {
    const campaign = await lookupCampaignBySlug(campaignMatch.slug);
    if (campaign) return 'credit-campaign';
  }
  return null;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const { user } = await getUserFromAuth({
    adminOnly: false,
    DANGEROUS_allowBlockedUsers: true,
  });

  let responsePath: string;

  if (!user) {
    responsePath = '/users/sign_in';
  } else if (user.blocked_reason) {
    responsePath = '/account-blocked';
  } else {
    const callbackPath = url.searchParams.get('callbackPath');
    if (callbackPath && isValidCallbackPath(callbackPath)) {
      responsePath = callbackPath;
    } else if (url.searchParams.get('source')) {
      // this is passed through by the sign-in page via cookie, too
      responsePath = '/sign-in-to-editor';
    } else {
      responsePath = await getProfileRedirectPath(user);
    }

    if (user.has_validation_stytch === null) {
      // New user: stamp which product they signed up for. Derived from
      // responsePath (the already-validated destination) rather than the raw
      // callbackPath query param, so the value cannot be user-tampered. This
      // runs exactly once per signup because has_validation_stytch is set
      // after account verification completes.
      const product = await resolveSignupProduct(
        callbackPath && isValidCallbackPath(callbackPath) ? responsePath : null,
        !!url.searchParams.get('source')
      );
      if (product) {
        PostHogClient().capture({
          distinctId: user.google_user_email,
          event: 'signup_product_attributed',
          properties: {
            first_product_signup: product,
            signup_destination: responsePath,
            $set_once: { first_product_signup: product },
          },
        });
      }

      // For new users needing verification, only pass callbackPath if explicitly provided.
      // Otherwise, account-verification will redirect to /get-started by default.
      if (callbackPath && isValidCallbackPath(callbackPath)) {
        responsePath = `/account-verification?callbackPath=${encodeURIComponent(callbackPath)}`;
      } else {
        responsePath = '/account-verification';
      }
    } else {
      responsePath = maybeInterceptWithSurvey(user, responsePath);
    }
  }

  // Resolve the Impact click ID: prefer the explicit URL param, fall back to
  // the shared parent-domain cookie written by kilo.ai. This is intentionally
  // separate from Impact's native IR_<campaignId> UTT cookie.
  const { affiliateTrackingId, impactCookieValue } = resolveImpactAffiliateTrackingId({
    imRefParam: url.searchParams.get('im_ref')?.trim() || null,
    sharedImpactCookieValue: request.cookies.get(IMPACT_CLICK_ID_COOKIE)?.value?.trim() || null,
    appTrackedImpactCookieValue:
      request.cookies.get(IMPACT_APP_TRACKED_CLICK_ID_COOKIE)?.value?.trim() || null,
  });

  if (user && affiliateTrackingId) {
    const existingAttribution = await getAffiliateAttribution(user.id, 'impact');

    if (!existingAttribution) {
      await recordAffiliateAttributionAndQueueParentEvent({
        userId: user.id,
        provider: 'impact',
        trackingId: affiliateTrackingId,
        customerEmail: user.google_user_email,
        eventDate: new Date(),
      });
    }
  }

  const response = NextResponse.redirect(new URL(responsePath, APP_URL));

  // Only set the marker after we've confirmed a user is present and the
  // cookie-based attribution path has been processed (recorded or skipped
  // because one already existed). Without this guard, an unauthenticated
  // hit would burn the marker and suppress the fallback on the next real
  // sign-in.
  if (user && impactCookieValue) {
    response.cookies.set(IMPACT_APP_TRACKED_CLICK_ID_COOKIE, impactCookieValue, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60, // 1 year
    });
  }

  return response;
}
