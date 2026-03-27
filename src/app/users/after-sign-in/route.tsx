import { getProfileRedirectPath, getUserFromAuth } from '@/lib/user.server';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { maybeInterceptWithSurvey } from '@/lib/survey-redirect';
import PostHogClient from '@/lib/posthog';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { APP_URL } from '@/lib/constants';

/**
 * Resolves a product identifier from the signup entry point. Returns null when
 * the entry point is generic (e.g. /get-started, /profile) so we leave the
 * property unset rather than guessing.
 */
function resolveSignupProduct(callbackPath: string | null, hasSource: boolean): string | null {
  if (hasSource) return 'kilo-code'; // IDE install flow
  if (!callbackPath) return null;
  if (callbackPath.startsWith('/claw')) return 'kiloclaw';
  if (callbackPath.startsWith('/cloud')) return 'cloud-agent';
  if (callbackPath.startsWith('/code-reviews')) return 'code-reviews';
  if (callbackPath.startsWith('/app-builder')) return 'app-builder';
  if (callbackPath.startsWith('/install')) return 'kilo-code';
  return null;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });

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
      const product = resolveSignupProduct(responsePath, !!url.searchParams.get('source'));
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

  return NextResponse.redirect(new URL(responsePath, APP_URL));
}
